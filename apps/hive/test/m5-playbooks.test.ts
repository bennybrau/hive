import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { estimateTokens } from "../src/brief.js";
import { createFact } from "../src/facts.js";
import { globToRegExp, PLAYBOOK_MAX_TOKENS, trimPlaybook } from "../src/playbooks.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };

const KEY = "gh/acme/proj";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const req = (method: "GET" | "POST" | "PUT" | "DELETE", token: string, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(token), ...(payload ? { payload: payload as object } : {}) });

async function create(body: Record<string, unknown>) {
  const res = await req("POST", curator.token, "/v1/playbooks", { scope: `repo:${KEY}`, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().playbook;
}
async function brief(body: Record<string, unknown>) {
  const res = await req("POST", alice.token, "/v1/brief", { repo_key: KEY, budget_tokens: 4000, ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate playbooks, llm_calls, reviews, anchors, facts, episodes, repos, instances cascade");
  await app?.close();
  app = buildApp(pool, { version: "test", embedder: new FakeEmbedder(), minSimilarity: 0.5 });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
});

describe("units", () => {
  it("globs: ** crosses folders, * and ? stay within one", () => {
    const m = (glob: string, p: string) => globToRegExp(glob).test(p);
    expect(m("scripts/e2e-*.sh", "scripts/e2e-brief.sh")).toBe(true);
    expect(m("scripts/e2e-*.sh", "scripts/sub/e2e-brief.sh")).toBe(false);
    expect(m("apps/registry/src/**", "apps/registry/src/db/pool.ts")).toBe(true);
    expect(m("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(m("src/**/*.ts", "src/x/y/a.ts")).toBe(true);
    expect(m("src/?.ts", "src/a.ts")).toBe(true);
    expect(m("src/?.ts", "src/ab.ts")).toBe(false);
    expect(m("a.b", "aXb")).toBe(false);
  });

  it("trim: steps go from the end first, then pitfalls, down to the cap", () => {
    const item = (i: number) => ({ text: `step ${i} ` + "word ".repeat(30), fact_ids: [] });
    const p = { id: "x", title: "T", scope: "global", steps: [0, 1, 2, 3, 4, 5].map(item), pitfalls: [item(9)] };
    const t = trimPlaybook(p);
    expect(estimateTokens(t)).toBeLessThanOrEqual(PLAYBOOK_MAX_TOKENS);
    expect(t.steps.length).toBeLessThan(6);
    expect(t.steps.length).toBeGreaterThan(0);
    expect(t.steps.map((s) => s.text)).toEqual(p.steps.slice(0, t.steps.length).map((s) => s.text));
    expect(t.pitfalls).toHaveLength(1);
    const noSteps = trimPlaybook({ ...p, steps: [], pitfalls: [0, 1, 2, 3, 4, 5].map(item) });
    expect(noSteps.pitfalls.map((s) => s.text)).toEqual([0, 1, 2, 3, 4, 5].map(item).slice(0, noSteps.pitfalls.length).map((s) => s.text));
    expect(estimateTokens(noSteps)).toBeLessThanOrEqual(PLAYBOOK_MAX_TOKENS);
  });
});

describe("/v1/playbooks", () => {
  it("create, read, edit (a new version), retract", async () => {
    const { fact } = await createFact(pool, { text: "Run the hive side in containers", kind: "convention", scope: `repo:${KEY}`, origin: "authored" }, curator.instance);
    const v1 = await create({
      title: "Writing an e2e script", applies_paths: ["scripts/e2e-*.sh"], applies_words: ["e2e"],
      steps: [{ text: "Run the Hive side in containers", fact_ids: [fact.id] }], pitfalls: [{ text: "Clean up on exit" }],
    });
    expect(v1).toMatchObject({
      scope: `repo:${KEY}`, status: "active", supersedes: null, author_user_id: "jon",
      steps: [{ text: "Run the Hive side in containers", fact_ids: [fact.id] }], pitfalls: [{ text: "Clean up on exit", fact_ids: [] }],
    });
    expect((await req("GET", alice.token, `/v1/playbooks/${v1.id}`)).json().playbook.id).toBe(v1.id);

    const put = await req("PUT", curator.token, `/v1/playbooks/${v1.id}`, { title: "Writing an e2e acceptance script" });
    expect(put.statusCode, put.body).toBe(200);
    const v2 = put.json().playbook;
    // scope and the rest come from the old row
    expect(v2).toMatchObject({ title: "Writing an e2e acceptance script", scope: `repo:${KEY}`, supersedes: v1.id, status: "active", steps: v1.steps, applies_paths: v1.applies_paths });
    expect((await req("GET", alice.token, `/v1/playbooks/${v1.id}`)).json().playbook.status).toBe("superseded");

    const list = await req("GET", alice.token, `/v1/playbooks?scope=${encodeURIComponent(`repo:${KEY}`)}`);
    expect(list.json().playbooks.map((p: { id: string }) => p.id)).toEqual([v2.id]);
    expect((await req("GET", alice.token, "/v1/playbooks?scope=global")).json().playbooks).toEqual([]);

    // editing an old version, or retracting it, conflicts
    expect((await req("PUT", curator.token, `/v1/playbooks/${v1.id}`, { title: "again" })).statusCode).toBe(409);
    expect((await req("DELETE", curator.token, `/v1/playbooks/${v1.id}`)).statusCode).toBe(409);

    const del = await req("DELETE", curator.token, `/v1/playbooks/${v2.id}`);
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().playbook.status).toBe("retracted");
    expect((await req("GET", alice.token, "/v1/playbooks")).json().playbooks).toEqual([]);
    expect((await req("DELETE", curator.token, `/v1/playbooks/${v2.id}`)).statusCode).toBe(409);

    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await req("GET", alice.token, `/v1/playbooks/${missing}`)).statusCode).toBe(404);
    expect((await req("PUT", curator.token, `/v1/playbooks/${missing}`, { title: "x" })).statusCode).toBe(404);
    expect((await req("DELETE", curator.token, `/v1/playbooks/${missing}`)).statusCode).toBe(404);
  });

  it("PUT can move a playbook to a different shared scope explicitly", async () => {
    const pb = await create({ title: "T", scope: "global" });
    const put = await req("PUT", curator.token, `/v1/playbooks/${pb.id}`, { scope: "repo", repo_key: KEY });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().playbook.scope).toBe(`repo:${KEY}`);
    expect((await req("GET", alice.token, "/v1/playbooks?scope=global")).json().playbooks).toEqual([]);
  });

  it("only a curator writes; facts must exist; scopes are shared only; limits apply", async () => {
    const pb = await create({ title: "T" });
    expect((await req("POST", alice.token, "/v1/playbooks", { scope: "global", title: "T" })).statusCode).toBe(403);
    expect((await req("PUT", alice.token, `/v1/playbooks/${pb.id}`, { title: "U" })).statusCode).toBe(403);
    expect((await req("DELETE", alice.token, `/v1/playbooks/${pb.id}`)).statusCode).toBe(403);

    const unknown = "00000000-0000-4000-8000-000000000001";
    const bad = await req("POST", curator.token, "/v1/playbooks", { scope: "global", title: "T", steps: [{ text: "s", fact_ids: [unknown] }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain(unknown);
    expect((await req("PUT", curator.token, `/v1/playbooks/${pb.id}`, { pitfalls: [{ text: "p", fact_ids: [unknown] }] })).statusCode).toBe(400);
    expect((await req("GET", alice.token, `/v1/playbooks/${pb.id}`)).json().playbook.status).toBe("active"); // rolled back

    const status = async (body: Record<string, unknown>) => (await req("POST", curator.token, "/v1/playbooks", { scope: "global", title: "T", ...body })).statusCode;
    expect(await status({ scope: "personal" })).toBe(400);
    expect(await status({ scope: "repo" })).toBe(400); // needs repo_key
    expect(await status({ scope: "repo", repo_key: KEY })).toBe(201);
    expect(await status({ title: "x".repeat(201) })).toBe(400);
    expect(await status({ steps: Array.from({ length: 21 }, () => ({ text: "s" })) })).toBe(400);
    expect(await status({ pitfalls: [{ text: "x".repeat(1001) }] })).toBe(400);
  });
});

describe("brief playbook section", () => {
  it("a glob match beats a word match; repo beats global; no match -> empty", async () => {
    const byWord = await create({ title: "By word", applies_words: ["invoice", "rounding"] });
    const byPath = await create({ title: "By path", applies_paths: ["src/billing/**"], steps: [{ text: "Run the money tests" }] });
    await create({ title: "Global by word", scope: "global", applies_words: ["invoice", "rounding"] });

    const b = await brief({ task: "Fix the invoice rounding", changed_paths: ["src/billing/invoice.ts"] });
    expect(b.playbook).toEqual([{ id: byPath.id, title: "By path", scope: `repo:${KEY}`, steps: [{ text: "Run the money tests", fact_ids: [] }], pitfalls: [] }]);
    expect(b.tokens.playbook).toBeGreaterThan(0);

    // no changed paths: word hits decide; the repo's own beats the global one with the same hits
    expect((await brief({ task: "Fix the invoice rounding" })).playbook.map((p: { id: string }) => p.id)).toEqual([byWord.id]);
    // whole words only
    expect((await brief({ task: "Fix the invoices" })).playbook).toEqual([]);
    expect((await brief({ task: "Tidy the webhook retries" })).playbook).toEqual([]);
  });

  it("a long playbook is cut to 300 tokens and counted in the budget", async () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({ text: `step ${i} ` + "word ".repeat(40) }));
    await create({ title: "Long", applies_words: ["webhook"], steps });
    const b = await brief({ task: "Tidy the webhook retries", budget_tokens: 400 });
    const [pb] = b.playbook;
    expect(pb.steps.length).toBeGreaterThan(0);
    expect(pb.steps.length).toBeLessThan(20);
    expect(pb.steps.map((s: { text: string }) => s.text)).toEqual(steps.slice(0, pb.steps.length).map((s) => s.text));
    expect(b.tokens.playbook).toBeLessThanOrEqual(PLAYBOOK_MAX_TOKENS);
    expect(b.tokens.playbook).toBe(estimateTokens(pb));
    expect(b.tokens.total).toBeLessThanOrEqual(400);
  });
});
