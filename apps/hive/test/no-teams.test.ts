import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { migrate, MIGRATIONS_DIR } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { createFact, type FactInput } from "../src/facts.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { createRepoSync, type RepoSync } from "../src/jobs/repo-sync.js";
import { createPlaybook } from "../src/playbooks.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { TEST_DB_URL } from "./helpers.js";
import { commit, makeRepo, sh, write } from "./repo-fixtures.js";

/**
 * The baseline for teams (bennybrau/hive#117): with no team in the database, every read answers exactly as it did
 * before migration 0017, in the same order. Later parts must leave the stored snapshot unchanged.
 */
let pool: pg.Pool;
let app: FastifyInstance;
let sync: RepoSync;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let repo: ReturnType<typeof makeRepo>;
let before: string;

const A = "gh/acme/proj";
const B = "gh/acme/lib";
const TASK = "Fix the invoice rounding in billing";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function call(token: string, method: "GET" | "POST", url: string, payload?: object) {
  const res = await app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json();
}
async function fact(label: string, input: Partial<FactInput> & { text: string }, by = curator.instance) {
  const { fact } = await createFact(pool, { kind: "convention", scope: `repo:${A}`, origin: "authored", ...input }, by);
  labels.set(fact.id, `fact:${label}`);
}

/** Seed ids → readable labels, so the snapshot shows which item came where. */
const labels = new Map<string, string>();

/** Ids become their seed label; times and git shas, which change between runs, are masked. */
function stable(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => labels.get(id) ?? "<id>")
      .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)/g, "<time>"),
  );
}

/**
 * The fixed set of reads. Use counts are reset first, since a brief or recall bumps them. Search breaks ties by the
 * table's physical row order, which those bumps reshuffle, so facts are put back in one order (by content) first.
 */
async function answers() {
  await pool.query("update facts set use_count = 0, cite_count = 0, last_used_at = null");
  await pool.query("cluster facts using facts_content_hash_key");
  const q = encodeURIComponent("invoice rounding billing");
  const out: Record<string, unknown> = {
    recall: await call(alice.token, "GET", `/v1/recall?q=${q}`),
    recall_repo: await call(alice.token, "GET", `/v1/recall?q=${q}&repo_key=${A}`),
    brief: await call(alice.token, "POST", "/v1/brief", { task: TASK, repo_key: A, changed_paths: ["src/billing/invoice.ts"] }),
    brief_also_repos: await call(alice.token, "POST", "/v1/brief", { task: TASK, repo_key: A, also_repos: [B] }),
  };
  for (const source of ["fact", "conversation", "history", "commit", "doc", "all"]) {
    out[`search_${source}`] = await call(alice.token, "GET", `/v1/search?q=${q}&repo_key=${A}&source=${source}`);
  }
  out.facts = await call(alice.token, "GET", "/v1/facts");
  out.review = await call(curator.token, "GET", "/v1/review/queue");
  return stable(out);
}

beforeAll(async () => {
  pool = createPool(TEST_DB_URL, 4);
  await pool.query("drop schema public cascade; create schema public;");
  const dir = mkdtempSync(path.join(tmpdir(), "hive-migrations-"));
  // 0020 (repo URL columns) is independent of 0017; the repo routes used below need it.
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && (f < "0017" || f.startsWith("0020_")))) {
    copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  await migrate(pool, dir);
  rmSync(dir, { recursive: true, force: true });

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
  const lib = path.join(repo.root, "lib");
  sh(repo.root, "init", "-q", "-b", "main", lib);
  sh(lib, "remote", "add", "origin", "git@github.com:acme/lib.git");
  write(lib, {
    "docs/rounding.md": "# Rounding\n\nThe lib's invoice rounding helper rounds billing amounts.\n",
    "src/billing/rounding.ts": "export const round = 1;\n",
  });
  commit(lib, "initial lib");
  const embedder = new FakeEmbedder();
  sync = createRepoSync(pool, { maxCommits: 500, intervalMin: 0, log: () => {} });
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5, repos: { roots: { root: repo.root, hostRoot: repo.root }, sync } });
  for (const [dir, key] of [[repo.dir, A], [lib, B]] as const) {
    await call(curator.token, "POST", "/v1/repos", { path: dir });
    await call(curator.token, "POST", "/v1/repos/ingest", { key });
  }

  await fact("repo-a", { text: "Invoice billing totals are rounded half-even" });
  await fact("repo-a-gotcha", { kind: "gotcha", locus: ["src/billing/invoice.ts"], text: "Invoice rounding in billing breaks on negative amounts" });
  await fact("repo-b", { scope: `repo:${B}`, text: "The lib rounds billing invoice amounts with bankers rounding" });
  await fact("global", { scope: "global", text: "Billing invoice rounding is documented in money docs" });
  await fact("alice-personal", { scope: "personal:alice", text: "Alice prefers to check invoice rounding by hand in billing" }, alice.instance);
  await fact("jon-personal", { scope: "personal:jon", text: "Jon keeps billing invoice rounding notes in a notebook" });
  await fact("candidate", { text: "Billing invoice rounding happens before tax" }, alice.instance);
  for (const [scope, title] of [["global", "Global"], [`repo:${A}`, "Proj"], [`repo:${B}`, "Lib"]]) {
    const p = await createPlaybook(pool, { scope: scope!, title: `${title} invoice playbook`, applies_words: ["invoice"], steps: [{ text: `${title} step` }] }, "jon");
    labels.set(p.id, `playbook:${title}`);
  }
  for (const [ref, key, mergedAt] of [["run_a", A, "2026-01-01T00:00:00Z"], ["run_b", B, "2026-02-01T00:00:00Z"]]) {
    const r = await call(curator.token, "POST", "/v1/episodes", {
      kind: "asf_run", repo_key: key, ref, content: "Plan: fix invoice rounding in billing.",
      metadata: { merged_at: mergedAt, title: ref, paths: ["src/billing/invoice.ts"] },
    });
    labels.set(r.episode.id, `episode:${ref}`);
  }
  for (const kind of ["turn", "session"]) {
    const r = await call(alice.token, "POST", "/v1/episodes", { kind, session_id: "s1", content: `Alice ${kind}: how is invoice rounding done in billing?` });
    labels.set(r.episode.id, `episode:${kind}`);
  }
  await runEmbedPass(pool, embedder);
  const commits = await pool.query<{ id: string; repo_key: string; subject: string }>(
    "select id, repo_key, split_part(content, E'\\n', 1) as subject from episodes where kind = 'commit'",
  );
  for (const c of commits.rows) labels.set(c.id, `commit:${c.repo_key}:${c.subject}`);
  const chunks = await pool.query<{ id: string; repo_key: string; path: string; chunk_index: number }>(
    "select id, repo_key, path, chunk_index from doc_chunks",
  );
  for (const c of chunks.rows) labels.set(c.id, `doc:${c.repo_key}:${c.path}#${c.chunk_index}`);

  before = JSON.stringify(await answers());
});
afterAll(async () => {
  await sync.stop();
  await app.close();
  repo.cleanup();
  await pool.end();
});

describe("no teams", () => {
  it("every read answers the same, in the same order, after migration 0017", async () => {
    const b = JSON.parse(before);
    expect(JSON.stringify(b)).not.toContain('"<id>"');
    expect((await migrate(pool))[0]).toBe("0017_teams.sql");
    const after = await answers();
    expect(after).toEqual(b);
    expect(after).toMatchSnapshot();
  });
});
