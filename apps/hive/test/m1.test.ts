import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { contentHash, initialStatus } from "../src/facts.js";
import { runEmbedPass, startEmbedWorker } from "../src/jobs/embed.js";
import { resolveScope, ScopeError } from "../src/scope.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let embedder: FakeEmbedder;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let bob: { instance: Instance; token: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function remember(token: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/facts", headers: auth(token), payload: body });
}
async function recall(token: string, q: string, extra = "") {
  const res = await app.inject({ url: `/v1/recall?q=${encodeURIComponent(q)}${extra}`, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as { mode: string; facts: { id: string; text: string; scope: string; matched: string[]; similarity: number | null }[] };
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, instances cascade");
  embedder = new FakeEmbedder();
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5 });
  curator = await createInstance(pool, { name: "jon-macbook", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
});

describe("scope + status rules (unit)", () => {
  const member: Instance = { id: "i", name: "n", user_id: "alice", role: "member" };
  it("resolves scope shorthands and refuses other people's personal scope", () => {
    expect(resolveScope("global", member)).toBe("global");
    expect(resolveScope("personal", member)).toBe("personal:alice");
    expect(resolveScope("repo", member, "gh/o/r")).toBe("repo:gh/o/r");
    expect(resolveScope("repo:gh/o/r", member)).toBe("repo:gh/o/r");
    expect(() => resolveScope("repo", member)).toThrow(ScopeError);
    expect(() => resolveScope("personal:bob", member)).toThrow(/another user/);
    expect(() => resolveScope("team", member)).toThrow(/unknown scope/);
  });
  it("hash ignores case and whitespace but not scope", () => {
    expect(contentHash("We  deploy to Cloud Run ", "global")).toBe(contentHash("we deploy to cloud run", "global"));
    expect(contentHash("x y z", "global")).not.toBe(contentHash("x y z", "repo:a"));
  });
  it("status: ingested/personal/curator active, member shared candidate", () => {
    expect(initialStatus("ingested", "global", "member")).toBe("active");
    expect(initialStatus("authored", "personal:a", "member")).toBe("active");
    expect(initialStatus("authored", "global", "curator")).toBe("active");
    expect(initialStatus("authored", "repo:x", "member")).toBe("candidate");
    expect(initialStatus("distilled", "global", "member")).toBe("candidate");
  });
});

describe("POST /v1/facts (remember)", () => {
  it("member shared fact is a candidate; same statement again is deduped to the same row", async () => {
    const a = await remember(alice.token, { text: "We deploy every service to Cloud Run.", kind: "decision", scope: "global" });
    expect(a.statusCode).toBe(201);
    expect(a.json().fact).toMatchObject({ status: "candidate", scope: "global", origin: "authored", author_user_id: "alice" });
    const again = await remember(bob.token, { text: "  we deploy every service to cloud run. ", kind: "decision", scope: "global" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ deduped: true, fact: { id: a.json().fact.id } });
    expect((await pool.query("select count(*)::int as n from facts")).rows[0].n).toBe(1);
  });

  it("curator shared fact is active and leaves an approve review", async () => {
    const r = await remember(curator.token, { text: "Payments team owns the Invoice API.", kind: "system", scope: "global" });
    expect(r.json().fact.status).toBe("active");
    const rev = await pool.query("select action, reviewer_user_id from reviews where fact_id = $1", [r.json().fact.id]);
    expect(rev.rows).toEqual([{ action: "approve", reviewer_user_id: "jon" }]);
  });

  it("personal fact is active and stored under the caller's user", async () => {
    const r = await remember(alice.token, { text: "I prefer small PRs.", kind: "preference", scope: "personal" });
    expect(r.json().fact).toMatchObject({ status: "active", scope: "personal:alice" });
  });

  it("rejects bad scope / kind with 400 and stores anchors", async () => {
    expect((await remember(alice.token, { text: "abc def", kind: "decision", scope: "personal:bob" })).statusCode).toBe(400);
    expect((await remember(alice.token, { text: "abc def", kind: "decision", scope: "repo" })).statusCode).toBe(400);
    expect((await remember(alice.token, { text: "abc def", kind: "opinion", scope: "global" })).statusCode).toBe(400);
    const r = await remember(alice.token, {
      text: "GATE_POLICY is org-tier only.", kind: "invariant", scope: "repo", repo_key: "gh/bennybrau/asf",
      locus: ["packages/settings/**"], anchors: [{ path: "packages/settings/src/registry.ts", line_start: 10, quote: "tier: 'org'" }],
    });
    expect(r.json().fact.scope).toBe("repo:gh/bennybrau/asf");
    const detail = await app.inject({ url: `/v1/facts/${r.json().fact.id}`, headers: auth(alice.token) });
    expect(detail.json().anchors).toHaveLength(1);
    expect(detail.json().anchors[0]).toMatchObject({ path: "packages/settings/src/registry.ts", verify_status: "unverified" });
  });
});

describe("recall + search", () => {
  async function seed() {
    for (const [text, scope, kind, extra] of [
      ["The Payments team owns the Invoice API.", "global", "system", {}],
      ["Services are deployed to Cloud Run by the factory.", "repo", "decision", { repo_key: "gh/o/asf" }],
      ["The billing worker retries three times.", "repo", "gotcha", { repo_key: "gh/o/other" }],
      ["Use vitest, never jest.", "global", "convention", {}],
    ] as const) {
      expect((await remember(curator.token, { text, scope, kind, ...extra })).statusCode).toBe(201);
    }
    await remember(alice.token, { text: "Alice keeps her payment notes here.", kind: "preference", scope: "personal" });
    await remember(bob.token, { text: "Bob suspects the payment retries are wrong.", kind: "gotcha", scope: "global" }); // candidate
  }

  it("keyword: a natural question matches on SOME of its words", async () => {
    await seed();
    embedder.fail = true; // force keyword-only
    const r = await recall(alice.token, "who owns the payments service?"); // "service" is in no fact: AND would match nothing
    expect(r.mode).toBe("keyword");
    expect(r.facts[0]!.text).toBe("The Payments team owns the Invoice API.");
  });

  it("meaning: finds a fact with no shared words once embedded, and drops unrelated ones", async () => {
    await seed();
    await runEmbedPass(pool, embedder);
    const r = await recall(alice.token, "how do we ship to production");
    expect(r.mode).toBe("hybrid");
    expect(r.facts.map((f) => f.text)).toEqual(["Services are deployed to Cloud Run by the factory."]);
    expect(r.facts[0]!.matched).toEqual(["meaning"]);
    expect(r.facts[0]!.similarity).toBeGreaterThan(0.9);
  });

  it("entitlement: active only, own personal yes, other personal no, repo_key narrows repos", async () => {
    await seed();
    await runEmbedPass(pool, embedder);
    const texts = async (tok: string, q: string, extra = "") => (await recall(tok, q, extra)).facts.map((f) => f.text);

    const forAlice = await texts(alice.token, "payment");
    expect(forAlice).toContain("Alice keeps her payment notes here.");
    expect(forAlice).not.toContain("Bob suspects the payment retries are wrong."); // candidate
    const forBob = await texts(bob.token, "payment");
    expect(forBob).not.toContain("Alice keeps her payment notes here.");

    expect(await texts(alice.token, "billing retries")).toContain("The billing worker retries three times.");
    const narrowed = await texts(alice.token, "billing retries", "&repo_key=gh/o/asf");
    expect(narrowed).not.toContain("The billing worker retries three times.");
    expect(narrowed).toContain("The Payments team owns the Invoice API."); // global still in
  });

  it("search can include candidates and reports bad sources", async () => {
    await seed();
    const r = await app.inject({ url: "/v1/search?q=payment%20retries&source=fact&include_candidates=true", headers: auth(alice.token) });
    expect(r.json().facts.map((f: { text: string }) => f.text)).toContain("Bob suspects the payment retries are wrong.");
    const bad = await app.inject({ url: "/v1/search?q=x&source=fact,wiki", headers: auth(alice.token) });
    expect(bad.statusCode).toBe(400);
  });
});

describe("episodes", () => {
  it("stores turns/sessions with identity from the token; search returns only your own", async () => {
    const post = (tok: string, body: object) => app.inject({ method: "POST", url: "/v1/episodes", headers: auth(tok), payload: body });
    const a = await post(alice.token, { kind: "turn", session_id: "s1", content: "user: why is the deploy to Cloud Run slow?\nassistant: cold starts" });
    expect(a.statusCode).toBe(201);
    await post(bob.token, { kind: "turn", session_id: "s2", content: "user: deploy to Cloud Run failed again" });
    await post(alice.token, { kind: "session", session_id: "s1", content: "whole session about postgres migrations", repo_key: "gh/o/asf" });

    const row = await pool.query("select user_id, instance_id from episodes where id = $1", [a.json().episode.id]);
    expect(row.rows[0]).toEqual({ user_id: "alice", instance_id: alice.instance.id });

    const s = await app.inject({ url: "/v1/search?q=deploy%20cloud%20run&source=conversation", headers: auth(alice.token) });
    const results = s.json().results as { source: string; snippet: string }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("conversation");
    expect(results[0]!.snippet).toContain("<b>"); // ts_headline marks matched words

    const h = await app.inject({ url: "/v1/search?q=postgres&source=history", headers: auth(alice.token) });
    expect(h.json().results).toHaveLength(1);
    expect((await post(alice.token, { kind: "doc", session_id: "s", content: "x" })).statusCode).toBe(400);
  });
});

describe("retract", () => {
  it("author or curator only; retracted facts leave recall", async () => {
    const f = (await remember(alice.token, { text: "Staging lives in eu-west-1.", kind: "system", scope: "personal" })).json().fact;
    const byBob = await app.inject({ method: "POST", url: `/v1/facts/${f.id}/retract`, headers: auth(bob.token), payload: { reason: "wrong" } });
    expect(byBob.statusCode).toBe(403);
    const byAlice = await app.inject({ method: "POST", url: `/v1/facts/${f.id}/retract`, headers: auth(alice.token), payload: { reason: "moved to us-east-1" } });
    expect(byAlice.json().fact).toMatchObject({ status: "retracted", status_note: "moved to us-east-1" });
    expect((await recall(alice.token, "staging")).facts).toHaveLength(0);
  });
});

describe("embed worker", () => {
  it("embeds the backlog, logs to llm_calls, and survives an embedder outage", async () => {
    await remember(curator.token, { text: "Use vitest, never jest.", kind: "convention", scope: "global" });
    const n = await runEmbedPass(pool, embedder);
    expect(n).toBe(1);
    const calls = await pool.query("select job, model, input_tokens, est_cost_usd from llm_calls");
    expect(calls.rows[0]).toMatchObject({ job: "embed", model: "fake-embed", est_cost_usd: "0.000000" });
    expect(calls.rows[0].input_tokens).toBeGreaterThan(0);

    embedder.fail = true;
    await remember(curator.token, { text: "Postgres is the only database.", kind: "decision", scope: "global" });
    const logs: string[] = [];
    const w = startEmbedWorker(pool, embedder, { idleMs: 10, errorBackoffMs: 10_000, log: (m) => logs.push(m) });
    await new Promise((r) => setTimeout(r, 100));
    expect(w.lastError()).toMatch(/fake embedder down/);
    expect(logs).toHaveLength(1); // logged once, not every retry
    const r = await recall(alice.token, "postgres database");
    expect(r.mode).toBe("keyword");
    expect(r.facts[0]!.text).toBe("Postgres is the only database.");
    await w.stop();
  });
});
