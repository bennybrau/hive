import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact, type FactInput } from "../src/facts.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { createRepoSync, type RepoSync } from "../src/jobs/repo-sync.js";
import { createPlaybook } from "../src/playbooks.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";
import { commit, makeRepo, sh, write } from "./repo-fixtures.js";

let pool: pg.Pool;
let app: FastifyInstance;
let sync: RepoSync;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let repo: ReturnType<typeof makeRepo>;
let embedder: FakeEmbedder;

const A = "gh/acme/proj";
const B = "gh/acme/lib";
const C = "gh/acme/other";
const TASK = "Fix the invoice rounding in billing";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });
const get = (token: string, url: string) => app.inject({ method: "GET", url, headers: auth(token) });

async function brief(body: Record<string, unknown>) {
  const res = await post(alice.token, "/v1/brief", { task: TASK, repo_key: A, budget_tokens: 4000, ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
async function getJson(url: string) {
  const res = await get(alice.token, url);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
async function fact(input: Partial<FactInput> & { text: string }) {
  const { fact } = await createFact(pool, { kind: "convention", scope: `repo:${A}`, origin: "authored", ...input }, curator.instance);
  return fact;
}
async function playbook(scope: string, title: string) {
  return createPlaybook(pool, { scope, title, applies_words: ["invoice"], steps: [{ text: `${title} step` }] }, "jon");
}
async function run(ref: string, repoKey: string, mergedAt: string) {
  const res = await post(curator.token, "/v1/episodes", {
    kind: "asf_run", repo_key: repoKey, ref, content: "Plan: fix invoice rounding.",
    metadata: { merged_at: mergedAt, title: ref, paths: ["src/billing/invoice.ts"] },
  });
  expect(res.statusCode, res.body).toBe(201);
}
/** Another git repo next to the first one, under the same root. */
function sibling(name: string, remote: string, files: Record<string, string>) {
  const dir = path.join(repo.root, name);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "remote", "add", "origin", remote);
  write(dir, files);
  commit(dir, `initial ${name}`);
  return dir;
}
async function register(dir: string, key: string) {
  expect((await post(curator.token, "/v1/repos", { path: dir })).statusCode).toBe(201);
  const res = await post(curator.token, "/v1/repos/ingest", { key });
  expect(res.statusCode, res.body).toBe(200);
}
const ids = (items: { id: string }[]) => items.map((i) => i.id);
const texts = (items: { text: string }[]) => items.map((i) => i.text);
/** A unit vector at cosine `cos` to `vecAt(1)`. */
const vecAt = (cos: number) => [cos, Math.sqrt(1 - cos * cos), ...new Array<number>(766).fill(0)];

/** Drop what changes between runs (ids, times, git shas) so an answer can be compared with a stored one. */
function stable(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
      .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)/g, "<time>"),
  );
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate playbooks, llm_calls, reviews, anchors, facts, episodes, doc_chunks, doc_files, repos, instances cascade");
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  repo = makeRepo(
    {
      "docs/money.md": "# Money\n\nInvoice totals are rounded half-even, per line.\n",
      "src/billing/invoice.ts": "export const total = 1;\n",
      "src/billing/invoice.test.ts": "// test\n",
    },
    { remote: "git@github.com:acme/proj.git" },
  );
  const lib = sibling("lib", "git@github.com:acme/lib.git", {
    "docs/rounding.md": "# Rounding\n\nThe lib's invoice rounding helper rounds billing amounts.\n",
    "src/billing/rounding.ts": "export const round = 1;\n",
    "src/billing/rounding.test.ts": "// lib test\n",
  });
  const other = sibling("other", "git@github.com:acme/other.git", {
    "docs/invoice.md": "# Invoice\n\nThe other repo's invoice rounding notes for billing.\n",
    "src/billing/invoice-other.ts": "export const x = 1;\n",
  });
  embedder = new FakeEmbedder();
  sync = createRepoSync(pool, { maxCommits: 500, intervalMin: 0, log: () => {} });
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5, repos: { roots: { root: repo.root, hostRoot: repo.root }, sync } });
  await register(repo.dir, A);
  await register(lib, B);
  await register(other, C);

  await fact({ text: "Invoice billing totals are rounded half-even" });
  await fact({ scope: `repo:${B}`, text: "The lib rounds billing invoice amounts with bankers rounding" });
  await fact({ scope: `repo:${C}`, text: "The other repo rounds billing invoice amounts up" });
  await fact({ scope: "global", text: "Billing invoice rounding is documented in money docs" });
  await playbook("global", "Global invoice playbook");
  await playbook(`repo:${B}`, "Lib invoice playbook");
  await playbook(`repo:${C}`, "Other invoice playbook");
  await run("run_a", A, "2026-01-01T00:00:00Z");
  await run("run_b", B, "2026-02-01T00:00:00Z");
  await run("run_c", C, "2026-03-01T00:00:00Z");
  await runEmbedPass(pool, embedder);
});
afterEach(async () => {
  await sync.stop();
  await app.close();
  repo.cleanup();
});

describe("without also_repos", () => {
  it("brief, recall and search answer as before", async () => {
    const q = encodeURIComponent("invoice rounding billing");
    const answers = {
      brief: await brief({ changed_paths: ["src/billing/invoice.ts"] }),
      recall: await getJson(`/v1/recall?q=${q}&repo_key=${encodeURIComponent(A)}`),
      search: await getJson(`/v1/search?q=${q}&repo_key=${encodeURIComponent(A)}&source=fact,commit,doc`),
    };
    expect(stable(answers)).toMatchSnapshot();
  });
});

describe("brief with also_repos", () => {
  it("reads the extra repo's facts and playbook; its locations and runs come after the main repo's", async () => {
    const b = await brief({ also_repos: [B] });
    expect(b.unknown_repos).toEqual([]);
    expect(texts(b.facts)).toContain("The lib rounds billing invoice amounts with bankers rounding");
    expect(texts(b.facts)).not.toContain("The other repo rounds billing invoice amounts up");
    expect(b.playbook.map((p: { title: string }) => p.title)).toEqual(["Lib invoice playbook"]); // an extra repo's beats global
    const repos = b.locations.map((l: { repo_key: string }) => l.repo_key);
    expect(repos.indexOf(B)).toBeGreaterThan(0);
    expect(repos.slice(repos.indexOf(B)).every((k: string) => k === B)).toBe(true);
    expect(repos.slice(0, repos.indexOf(B)).every((k: string) => k === A)).toBe(true);
    expect(b.locations).toContainEqual({ ref: "src/billing/rounding.ts", path: "src/billing/rounding.ts", source: "path", repo_key: B });
    expect(b.runs.map((r: { ref: string; repo_key: string }) => [r.ref, r.repo_key])).toEqual([["run_a", A], ["run_b", B]]);
    expect(b.tests.map((t: { path: string }) => t.path)).not.toContain("src/billing/rounding.test.ts"); // tests: main repo only
  });

  it("on a tie the main repo wins, for facts and playbook", async () => {
    // a real tie under rank fusion: B's fact is first by keyword and second by meaning, A's the other way round
    const task = "zebra crossing";
    const bText = "zebra crossing zebra crossing rule";
    const aText = "zebra crossing is how we do it in the main repo";
    embedder.fixed.set(task, vecAt(1)).set(aText, vecAt(1)).set(bText, vecAt(0.9));
    const bFact = await fact({ scope: `repo:${B}`, text: bText });
    const aFact = await fact({ text: aText });
    await runEmbedPass(pool, embedder);
    const plain = await getJson(`/v1/recall?q=${encodeURIComponent(task)}`); // every repo readable, no tie-break
    expect(ids(plain.facts)).toEqual([bFact.id, aFact.id]);
    expect(plain.facts[0].score).toBe(plain.facts[1].score);
    const recall = await getJson(`/v1/recall?q=${encodeURIComponent(task)}&repo_key=${A}&also_repos=${B}`);
    expect(ids(recall.facts)).toEqual([aFact.id, bFact.id]);
    expect(ids((await brief({ task, also_repos: [B] })).facts)).toEqual([aFact.id, bFact.id]);

    await playbook(`repo:${A}`, "Proj invoice playbook");
    await playbook(`repo:${B}`, "Newer lib invoice playbook");
    expect((await brief({ also_repos: [B] })).playbook[0].title).toBe("Proj invoice playbook");
  });

  it("more than 3 is a 400; duplicates and repo_key itself are dropped; an unregistered repo is reported, not read", async () => {
    const four = await post(alice.token, "/v1/brief", { task: TASK, repo_key: A, also_repos: [B, C, "x/1", "x/2"] });
    expect(four.statusCode).toBe(400);
    await fact({ scope: "repo:gh/acme/nope", text: "Unregistered repo billing invoice rounding note" });
    await runEmbedPass(pool, embedder);
    const b = await brief({ also_repos: [` ${B} `, B, A] });
    expect(b.unknown_repos).toEqual([]);
    expect(texts(b.facts)).toContain("The lib rounds billing invoice amounts with bankers rounding");
    expect(texts(b.facts)).not.toContain("Unregistered repo billing invoice rounding note");
    expect(b.runs.map((r: { ref: string }) => r.ref)).toEqual(["run_a", "run_b"]); // B once
    expect(new Set(b.locations.map((l: { repo_key: string }) => l.repo_key))).toEqual(new Set([A, B]));
    const nope = await brief({ also_repos: ["gh/acme/nope", B] });
    expect(nope.unknown_repos).toEqual(["gh/acme/nope"]);
    expect(texts(nope.facts)).toContain("The lib rounds billing invoice amounts with bankers rounding");
    expect(texts(nope.facts)).not.toContain("Unregistered repo billing invoice rounding note");
  });
});

describe("recall and search with also_repos", () => {
  const q = encodeURIComponent("invoice rounding billing");

  it("return the named repo's facts and docs, never an unnamed repo's", async () => {
    const recall = await getJson(`/v1/recall?q=${q}&repo_key=${A}&also_repos=${B}`);
    expect(recall.unknown_repos).toEqual([]);
    expect(texts(recall.facts)).toContain("The lib rounds billing invoice amounts with bankers rounding");
    expect(recall.facts.map((f: { scope: string }) => f.scope)).not.toContain(`repo:${C}`);

    const search = await getJson(`/v1/search?q=${q}&repo_key=${A}&also_repos=${B},gh/acme/nope&source=fact,commit,doc`);
    expect(search.unknown_repos).toEqual(["gh/acme/nope"]);
    expect(texts(search.facts)).toContain("The lib rounds billing invoice amounts with bankers rounding");
    expect(search.facts.map((f: { scope: string }) => f.scope)).not.toContain(`repo:${C}`);
    const repos = new Set(search.results.map((r: { repo_key: string }) => r.repo_key));
    expect(repos.has(B)).toBe(true);
    expect(repos.has(C)).toBe(false);
    expect(search.results).toContainEqual(expect.objectContaining({ source: "doc", repo_key: B, path: "docs/rounding.md" }));
  });

  it("more than 3 is a 400; without repo_key also_repos is ignored", async () => {
    expect((await get(alice.token, `/v1/recall?q=${q}&repo_key=${A}&also_repos=a,b,c,d`)).statusCode).toBe(400);
    expect((await get(alice.token, `/v1/search?q=${q}&repo_key=${A}&also_repos=a,b,c,d`)).statusCode).toBe(400);
    const r = await getJson(`/v1/recall?q=${q}&also_repos=a,b,c,d`);
    expect(r.unknown_repos).toBeUndefined();
  });
});
