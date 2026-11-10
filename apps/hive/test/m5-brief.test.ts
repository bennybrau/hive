import { rmSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { BRIEF_MAIN_SHARE, estimateTokens, nearbyTests, packBudget, packShared } from "../src/brief.js";
import { createFact, type FactInput } from "../src/facts.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { createRepoSync, type RepoSync } from "../src/jobs/repo-sync.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";
import { commit, makeRepo, write } from "./repo-fixtures.js";

let pool: pg.Pool;
let app: FastifyInstance;
let sync: RepoSync;
let embedder: FakeEmbedder;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let bob: { instance: Instance; token: string };
let repo: ReturnType<typeof makeRepo>;

const KEY = "gh/acme/proj";
const TASK = "Fix the invoice rounding in billing";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });

async function brief(token: string, body: Record<string, unknown>) {
  const res = await post(token, "/v1/brief", { task: TASK, repo_key: KEY, ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
async function fact(input: Partial<FactInput> & { text: string }, who = curator.instance) {
  const { fact } = await createFact(pool, { kind: "convention", scope: `repo:${KEY}`, origin: "authored", ...input }, who);
  return fact;
}
async function ingest() {
  const res = await post(curator.token, "/v1/repos/ingest", { key: KEY });
  expect(res.statusCode, res.body).toBe(200);
}
const paths = (items: { path: string }[]) => items.map((i) => i.path);
async function run(ref: string, metadata: Record<string, unknown>, content = "Plan: tidy the webhook retries.", repoKey = KEY) {
  const res = await post(curator.token, "/v1/episodes", { kind: "asf_run", repo_key: repoKey, ref, content, metadata });
  expect(res.statusCode, res.body).toBe(201);
}
const refs = (b: { runs: { ref: string }[] }) => b.runs.map((r) => r.ref);

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, doc_chunks, doc_files, repos, instances cascade");
  embedder = new FakeEmbedder();
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
  repo = makeRepo(
    {
      "README.md": "# Proj\n\nThe factory deploys to Cloud Run.\n",
      "docs/money.md": "# Money\n\nIntro.\n\n## Rounding\n\nInvoice totals are rounded half-even, per line.\n",
      "src/billing/invoice.ts": "export const total = 1;\n",
      "src/billing/tax.ts": "export const rate = 0.2;\n",
      "src/billing/invoice.test.ts": "// test\n",
      "src/billing/helpers.spec.ts": "// spec\n",
      "src/billing/sub/deep.test.ts": "// deep\n",
      "src/routes/route.test.ts": "// sibling\n",
      "test/unrelated.test.ts": "// far away\n",
      "node_modules/x/invoice.js": "vendored\n",
    },
    { remote: "git@github.com:acme/proj.git" },
  );
  sync = createRepoSync(pool, { maxCommits: 500, intervalMin: 0, log: () => {} });
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5, repos: { roots: { root: repo.root, hostRoot: repo.root }, sync } });
  expect((await post(curator.token, "/v1/repos", { path: repo.dir })).statusCode).toBe(201);
});
afterEach(async () => {
  await sync.stop();
  await app.close();
  repo.cleanup();
});

describe("repo_files", () => {
  it("ingest mirrors tracked files (minus vendored dirs), writes nothing when unchanged, applies edits and deletions", async () => {
    await ingest();
    const rows = async () =>
      new Map((await pool.query<{ path: string; xmin: string }>("select path, xmin::text from repo_files where repo_key = $1", [KEY])).rows.map((r) => [r.path, r.xmin]));
    const first = await rows();
    expect([...first.keys()].sort()).toEqual([
      "README.md", "docs/money.md", "src/billing/helpers.spec.ts", "src/billing/invoice.test.ts", "src/billing/invoice.ts",
      "src/billing/sub/deep.test.ts", "src/billing/tax.ts", "src/routes/route.test.ts", "test/unrelated.test.ts",
    ]);
    await ingest();
    expect(await rows()).toEqual(first); // same row versions: nothing rewritten

    write(repo.dir, { "src/billing/tax.ts": "export const rate = 0.25;\n", "src/billing/refund.ts": "x\n" });
    rmSync(path.join(repo.dir, "test/unrelated.test.ts"));
    commit(repo.dir, "refunds");
    await ingest();
    const third = await rows();
    expect(third.has("test/unrelated.test.ts")).toBe(false);
    expect(third.has("src/billing/refund.ts")).toBe(true);
    expect(third.get("src/billing/tax.ts")).not.toBe(first.get("src/billing/tax.ts"));
    expect(third.get("README.md")).toBe(first.get("README.md"));
  });
});

describe("units", () => {
  it("nearby tests: name match, then same folder or below, then a folder next to it; top 5", () => {
    const tests = [
      "test/unrelated.test.ts", "src/routes/route.test.ts", "src/billing/sub/deep.test.ts",
      "src/billing/helpers.spec.ts", "src/billing/invoice.test.ts",
    ];
    expect(nearbyTests(tests, ["src/billing/invoice.ts"])).toEqual([
      { path: "src/billing/invoice.test.ts", near: "src/billing/invoice.ts", why: "name" },
      { path: "src/billing/helpers.spec.ts", near: "src/billing/invoice.ts", why: "folder" },
      { path: "src/billing/sub/deep.test.ts", near: "src/billing/invoice.ts", why: "folder" },
      { path: "src/routes/route.test.ts", near: "src/billing/invoice.ts", why: "sibling" },
    ]);
    // a name match anywhere beats proximity; a location is never its own test; at most 5
    expect(nearbyTests(["test/invoice.spec.ts", "src/billing/a.test.ts"], ["src/billing/invoice.ts"]).map((t) => t.why)).toEqual(["name", "folder"]);
    expect(nearbyTests(["src/x.test.ts"], ["src/x.test.ts"])).toEqual([]);
    expect(nearbyTests(Array.from({ length: 9 }, (_, i) => `src/billing/t${i}.test.ts`), ["src/billing/invoice.ts"])).toHaveLength(5);
  });

  it("budget: round-robin in priority order, skipping what doesn't fit", () => {
    const item = (n: number) => ({ t: "x".repeat(n) });
    const { out, tokens, dropped } = packBudget(
      { playbook: [], gotchas: [item(30), item(30)], facts: [item(390)], locations: [item(30), item(30)], runs: [item(30)], tests: [item(30)] },
      50,
    );
    // gotcha 1, (fact too big), location 1, run 1, test 1, gotcha 2 -> location 2 no longer fits
    const cost = estimateTokens(item(30));
    expect(out.gotchas).toHaveLength(2);
    expect(out.facts).toHaveLength(0);
    expect(out.locations).toHaveLength(1);
    expect(out.runs).toHaveLength(1);
    expect(out.tests).toHaveLength(1);
    expect(dropped).toEqual({ playbook: 0, gotchas: 0, facts: 1, locations: 1, runs: 0, tests: 0 });
    expect(tokens).toEqual({ playbook: 0, gotchas: 2 * cost, facts: 0, locations: cost, runs: cost, tests: cost, total: 5 * cost });
  });

  it("shared budget: the main repo's items are packed first, into BRIEF_MAIN_SHARE of it", () => {
    const item = (tag: string, n: number) => ({ t: tag + "x".repeat(n) });
    const none = { playbook: [], gotchas: [], facts: [], locations: [], runs: [], tests: [] };
    // like the live stack: main has one fact and 4 locations; the extra repo has more and bigger gotchas, facts, locations
    const main = { ...none, facts: [item("mf", 400)], locations: [1, 2, 3, 4].map((i) => item(`ml${i}`, 120)) };
    const extra = {
      ...none,
      gotchas: [1, 2, 3, 4].map((i) => item(`eg${i}`, 800)),
      facts: [1, 2, 3, 4, 5, 6].map((i) => item(`ef${i}`, 400)),
      locations: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => item(`el${i}`, 120)),
    };
    const plain = packBudget({ ...none, gotchas: extra.gotchas, facts: [...main.facts, ...extra.facts], locations: [...main.locations, ...extra.locations] }, 600);
    expect(plain.out.locations.filter((l) => main.locations.includes(l as never)).length).toBeLessThan(4); // plain packing drops some

    const { out, tokens, dropped } = packShared(main, extra, 600, BRIEF_MAIN_SHARE);
    expect(out.facts[0]).toBe(main.facts[0]);
    expect(out.locations.slice(0, 4)).toEqual(main.locations);
    expect(out.gotchas.length).toBeGreaterThan(0);
    expect(tokens.total).toBeLessThanOrEqual(600);
    expect(tokens.total).toBe(Object.values({ ...tokens, total: 0 }).reduce((a, b) => a + b, 0));
    const offered = { gotchas: 4, facts: 7, locations: 12 };
    for (const [s, n] of Object.entries(offered)) expect(out[s as keyof typeof out].length + dropped[s as keyof typeof dropped]).toBe(n);
  });

  it("shared budget: with nothing from the main repo, the extra repos get all of it", () => {
    const item = (n: number) => ({ t: "x".repeat(n) });
    const none = { playbook: [], gotchas: [], facts: [], locations: [], runs: [], tests: [] };
    const extra = { ...none, gotchas: [item(30), item(30)], facts: [item(390)], locations: [item(30), item(30)], runs: [item(30)], tests: [item(30)] };
    const shared = packShared(none, extra, 50, BRIEF_MAIN_SHARE);
    expect(shared).toEqual(packBudget(extra, 50));
    expect(shared.tokens.total).toBeLessThanOrEqual(50);
  });
});

describe("POST /v1/brief", () => {
  beforeEach(async () => {
    await ingest();
  });

  it("returns terms, gated facts, locations from docs and paths, and nearby tests", async () => {
    const rounding = await fact({ text: "Invoice billing totals are rounded half-even" });
    await fact({ text: "The factory deploys to Cloud Run on merge" }); // unrelated
    // shares a word and some meaning (similarity ~0.58, above search's 0.5 floor) but is below the 0.62 gate
    await fact({ text: "billing deploys to production after postgres migrations" });
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token, { budget_tokens: 4000 });

    expect(b).toMatchObject({ repo_key: KEY, repo_indexed: true, mode: "hybrid", budget_tokens: 4000 });
    expect(b.terms).toEqual(["bill", "fix", "invoic", "round"]);
    expect(b.facts.map((f: { id: string }) => f.id)).toEqual([rounding.id]);
    // doc passage cited with lines; code found by path, file-name matches first; no duplicates, nothing vendored
    expect(b.locations).toContainEqual({ ref: "docs/money.md:1-7", path: "docs/money.md", source: "doc" });
    expect(b.locations).toContainEqual({ ref: "src/billing/invoice.ts", path: "src/billing/invoice.ts", source: "path" });
    const locs = paths(b.locations);
    expect(new Set(locs).size).toBe(locs.length);
    expect(locs.length).toBeLessThanOrEqual(8);
    expect(locs.indexOf("src/billing/invoice.ts")).toBeLessThan(locs.indexOf("src/billing/tax.ts"));
    expect(locs).not.toContain("node_modules/x/invoice.js");
    expect(b.tests.length).toBeLessThanOrEqual(5);
    expect(paths(b.tests).filter((p: string) => locs.includes(p))).toEqual([]);
    expect(b.runs).toEqual([]);
    expect(b.playbook).toEqual([]);
    expect(b.dropped).toEqual({ playbook: 0, gotchas: 0, facts: 0, locations: 0, runs: 0, tests: 0 });
    const sum = (["playbook", "gotchas", "facts", "locations", "runs", "tests"] as const).reduce((n, s) => n + b.tokens[s], 0);
    expect(b.tokens.total).toBe(sum);
  });

  it("finds the test next to a location", async () => {
    const b = await brief(alice.token, { task: "change the tax rate in ui", budget_tokens: 4000 });
    expect(b.terms).toEqual(["chang", "rate", "tax"]); // "ui" is too short to match paths usefully
    expect(paths(b.locations)).toContain("src/billing/tax.ts");
    expect(b.tests).toContainEqual({ path: "src/billing/helpers.spec.ts", near: "src/billing/tax.ts", why: "folder" });
    expect(paths(b.tests)).not.toContain("test/unrelated.test.ts");
  });

  it("path matches: a term in the file name counts double; a doc found both ways is listed once", async () => {
    write(repo.dir, {
      "src/rounding.ts": "x\n", // one term, in the file name
      "lib/fix/bill/util.ts": "x\n", // two terms, folders only
      "docs/rounding.md": "# Rounding\n\nInvoice billing rounding is half-even.\n",
    });
    commit(repo.dir, "more files");
    await ingest();
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token, { budget_tokens: 4000 });
    const locs = paths(b.locations);
    expect(locs.indexOf("src/rounding.ts")).toBeGreaterThan(-1);
    expect(locs.indexOf("src/rounding.ts")).toBeLessThan(locs.indexOf("lib/fix/bill/util.ts"));
    expect(locs.filter((p: string) => p === "docs/rounding.md")).toHaveLength(1);
  });

  it("changed paths lift a located fact (locus boost)", async () => {
    const top = await fact({ text: "billing invoice rounding uses cents" });
    const located = await fact({ text: "billing exports to postgres nightly", locus: ["src/billing/export.ts"] });
    await runEmbedPass(pool, embedder);
    const plain = await brief(alice.token, {});
    expect(plain.facts.map((f: { id: string }) => f.id)).toEqual([top.id, located.id]);
    const near = await brief(alice.token, { changed_paths: ["src/billing/export.ts"] });
    expect(near.facts.map((f: { id: string }) => f.id)).toEqual([located.id, top.id]);
    expect(near.facts[0].near_changes).toBe(true);
  });

  it("gotchas: active ones whose locus or anchors overlap the locations or changed paths, shown once", async () => {
    const onBilling = await fact({ kind: "gotcha", text: "billing invoice code caches tax rates for an hour", locus: ["src/billing"] });
    const anchored = await fact({ kind: "gotcha", text: "money doc is generated", anchors: [{ repo_key: KEY, path: "docs/money.md" }] });
    const elsewhere = await fact({ kind: "gotcha", text: "the payments webhook retries forever", locus: ["src/hooks"] });
    await fact({ kind: "gotcha", text: "billing draft gotcha", locus: ["src/billing"] }, alice.instance); // candidate
    await runEmbedPass(pool, embedder);

    const b = await brief(alice.token, { budget_tokens: 4000 });
    const ids = b.gotchas.map((g: { id: string }) => g.id).sort();
    expect(ids).toEqual([onBilling.id, anchored.id].sort());
    expect(b.facts.map((f: { id: string }) => f.id)).not.toContain(onBilling.id); // in gotchas only
    expect(b.gotchas[0]).toMatchObject({ kind: "gotcha" });

    const withChange = await brief(alice.token, { budget_tokens: 4000, changed_paths: ["src/hooks/retry.ts"] });
    expect(withChange.gotchas.map((g: { id: string }) => g.id)).toContain(elsewhere.id);
  });

  it("budget caps the brief; gotchas get the first slots", async () => {
    await fact({ kind: "gotcha", text: "billing gotcha: invoice totals are cached " + "very ".repeat(20), locus: ["src/billing"] });
    for (let i = 0; i < 5; i++) await fact({ text: `billing invoice rule number ${i} ` + "long ".repeat(30) });
    for (let i = 0; i < 3; i++) await run(`run_${i}`, { merged_at: `2026-0${i + 1}-01T00:00:00Z`, title: "long ".repeat(30), paths: ["src/billing/invoice.ts"] });
    await runEmbedPass(pool, embedder);
    const full = await brief(alice.token, { budget_tokens: 4000 });
    const small = await brief(alice.token, { budget_tokens: 100 });
    expect(small.tokens.total).toBeLessThanOrEqual(100);
    expect(full.tokens.total).toBeGreaterThan(100);
    expect(small.gotchas).toHaveLength(1);
    expect(full.runs).toHaveLength(3);
    expect(small.dropped.runs).toBeGreaterThan(0);
    expect(full.tokens.runs).toBeGreaterThan(0);
    const dropped = Object.values(small.dropped as Record<string, number>).reduce((a, b) => a + b, 0);
    const count = (b: Record<string, unknown[]>) => b.gotchas!.length + b.facts!.length + b.locations!.length + b.runs!.length + b.tests!.length;
    expect(count(small) + dropped).toBe(count(full));
  });

  it("scope isolation: never another user's personal facts or another repo's", async () => {
    await fact({ kind: "gotcha", scope: "personal:alice", text: "billing: my own invoice note", locus: ["src/billing"] }, alice.instance);
    await fact({ scope: "personal:alice", text: "billing invoice rounding personal reminder" }, alice.instance);
    await fact({ scope: "repo:gh/acme/other", text: "billing invoice rounding in the other repo" });
    await fact({ kind: "gotcha", scope: "repo:gh/acme/other", text: "other repo billing gotcha", locus: ["src/billing"] });
    await runEmbedPass(pool, embedder);
    const forAlice = await brief(alice.token, { budget_tokens: 4000 });
    expect(forAlice.gotchas.map((g: { text: string }) => g.text)).toEqual(["billing: my own invoice note"]);
    expect(forAlice.facts.map((f: { text: string }) => f.text)).toEqual(["billing invoice rounding personal reminder"]);
    const forBob = await brief(bob.token, { budget_tokens: 4000 });
    expect(forBob.gotchas).toEqual([]);
    expect(forBob.facts).toEqual([]);
  });

  it("an unregistered repo: 200 with facts only and repo_indexed false", async () => {
    const g = await fact({ scope: "global", text: "billing invoices are rounded half-even everywhere" });
    await fact({ scope: "global", kind: "gotcha", text: "billing global gotcha", locus: ["src/billing"] });
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token, { repo_key: "gh/acme/nope", budget_tokens: 4000, changed_paths: ["src/billing/x.ts"] });
    expect(b).toMatchObject({ repo_key: "gh/acme/nope", repo_indexed: false, locations: [], runs: [], tests: [], gotchas: [] });
    expect(b.facts.map((f: { id: string }) => f.id)).toContain(g.id);
  });

  it("runs: a merged run that touched the changed paths is listed", async () => {
    await run("run_hooks", { merged_at: "2026-02-01T10:00:00Z", title: "Webhook retries", pr_url: "https://github.com/acme/proj/pull/7", paths: ["src/hooks/retry.ts"] });
    expect((await brief(alice.token, {})).runs).toEqual([]); // no path or word in common
    const b = await brief(alice.token, { changed_paths: ["src/hooks/retry.ts"] });
    expect(b.runs).toEqual([{
      ref: "run_hooks", title: "Webhook retries", pr_url: "https://github.com/acme/proj/pull/7", merged_at: "2026-02-01T10:00:00Z",
      snippet: expect.stringContaining("webhook"),
    }]);
    expect(b.tokens.runs).toBeGreaterThan(0);
  });

  it("runs: most paths touched first, then a word match, then the newest; top 3", async () => {
    const changed = ["src/hooks/a.ts", "src/hooks/b.ts"];
    await run("both_old", { merged_at: "2025-01-01T00:00:00Z", paths: changed });
    await run("one_old_words", { merged_at: "2025-06-01T00:00:00Z", paths: ["src/hooks/a.ts"] }, "Fix invoice rounding in the hooks");
    await run("one_new", { merged_at: "2026-03-01T00:00:00Z", paths: ["src/hooks/a.ts"] });
    await run("one_newer", { merged_at: "2026-04-01T00:00:00+02:00", paths: ["src/hooks/a.ts", "README.md"] });
    await run("one_oldest", { merged_at: "2024-01-01T00:00:00Z", paths: ["src/hooks/b.ts"] });
    const b = await brief(alice.token, { changed_paths: changed, budget_tokens: 4000 });
    expect(refs(b)).toEqual(["both_old", "one_old_words", "one_newer"]);
  });

  it("runs: a word match alone is enough", async () => {
    await run("words", { merged_at: "2026-02-01T00:00:00Z" }, "Plan: fix invoice rounding.\nReview: billing now rounds half-even.");
    const b = await brief(alice.token, {});
    expect(refs(b)).toEqual(["words"]);
    expect(b.runs[0]).toEqual({ ref: "words", title: null, pr_url: null, merged_at: "2026-02-01T00:00:00Z", snippet: expect.stringContaining("<b>") });
  });

  it("runs: never unmerged runs or another repo's", async () => {
    const content = "Plan: fix invoice rounding in billing.";
    await pool.query(
      `insert into episodes (kind, repo_key, ref, content, metadata) values ('asf_run', $1, 'unmerged', $2, $3)`,
      [KEY, content, { paths: ["src/billing/invoice.ts"] }],
    );
    await pool.query("insert into repos (key) values ('gh/acme/other')");
    await run("elsewhere", { merged_at: "2026-02-01T00:00:00Z", paths: ["src/billing/invoice.ts"] }, content, "gh/acme/other");
    const b = await brief(alice.token, { changed_paths: ["src/billing/invoice.ts"] });
    expect(b.runs).toEqual([]);
  });

  it("validates the body", async () => {
    const bad = async (body: Record<string, unknown>) => (await post(alice.token, "/v1/brief", { task: TASK, repo_key: KEY, ...body })).statusCode;
    expect(await bad({ budget_tokens: 99 })).toBe(400);
    expect(await bad({ budget_tokens: 4001 })).toBe(400);
    expect(await bad({ changed_paths: Array.from({ length: 201 }, (_, i) => `f${i}`) })).toBe(400);
    expect(await bad({ task: "" })).toBe(400);
    expect(await bad({ repo_key: undefined })).toBe(400);
    expect((await brief(alice.token, {})).budget_tokens).toBe(600);
    expect((await app.inject({ method: "POST", url: "/v1/brief", payload: { task: TASK, repo_key: KEY } })).statusCode).toBe(401);
  });
});
