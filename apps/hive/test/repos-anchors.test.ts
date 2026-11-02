import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact } from "../src/facts.js";
import { createRepoSync, type RepoSync } from "../src/jobs/repo-sync.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let sync: RepoSync;
let curator: { instance: Instance; token: string };

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate reviews, anchors, facts, episodes, doc_chunks, doc_files, repos, instances cascade");
  sync = createRepoSync(pool, { maxCommits: 500, intervalMin: 0, log: () => {} });
  app = buildApp(pool, { version: "test", embedder: new FakeEmbedder(), repos: { roots: { root: "/repos", hostRoot: "/repos" }, sync } });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
});
afterEach(async () => {
  await sync.stop();
});

async function fact(text: string, scope: string, status: string): Promise<string> {
  const { fact } = await createFact(pool, { text, kind: "convention", scope, origin: "authored" }, curator.instance);
  await pool.query("update facts set status = $2 where id = $1", [fact.id, status]);
  return fact.id;
}
async function anchor(factId: string, repoKey: string | null, status: string): Promise<void> {
  await pool.query("insert into anchors (fact_id, repo_key, path, quote, verify_status) values ($1, $2, 'README.md', 'q', $3)", [
    factId, repoKey, status,
  ]);
}

describe("GET /v1/repos anchors", () => {
  it("counts live facts' anchors per repo by status, keyed by repo_key or the fact's repo: scope", async () => {
    await pool.query("insert into repos (key, local_path) values ('gh/acme/a', '/repos/a'), ('gh/acme/b', '/repos/b')");
    const active = await fact("Repo A uses pnpm workspaces", "global", "active");
    await anchor(active, "gh/acme/a", "verified");
    const candidate = await fact("Repo A deploys from main", "global", "candidate");
    await anchor(candidate, "gh/acme/a", "drifted");
    const scoped = await fact("Repo A keeps docs in docs/", "repo:gh/acme/a", "active");
    await anchor(scoped, null, "missing"); // only the scope says which repo
    const retracted = await fact("Repo A used yarn once", "global", "retracted");
    await anchor(retracted, "gh/acme/a", "verified");

    const res = await app.inject({ url: "/v1/repos", headers: { authorization: `Bearer ${curator.token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const byKey = Object.fromEntries((res.json().repos as { key: string; anchors: unknown; docs: number }[]).map((r) => [r.key, r]));
    expect(byKey["gh/acme/a"]!.anchors).toEqual({ verified: 1, drifted: 1, missing: 1, unverifiable_here: 0, unverified: 0 });
    expect(byKey["gh/acme/b"]!.anchors).toEqual({ verified: 0, drifted: 0, missing: 0, unverifiable_here: 0, unverified: 0 });
    expect(byKey["gh/acme/b"]!.docs).toBe(0);
  });
});
