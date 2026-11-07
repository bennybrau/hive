import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

const KEY = randomBytes(32);
const REPO = "gh/acme/api";
const RUN = `# Plan
Add a nightly export of invoices.

# Review
Decided: exports run from the replica, never the primary, because the export query locks the invoices table.
Gotcha: the replica lags up to ten minutes, so the export must not be used for reconciliation.`;
const META = { merged_at: "2026-11-01T12:00:00Z", pr_url: "https://github.com/acme/api/pull/9", title: "Nightly invoice export", paths: ["src/export.ts"] };

type Who = { instance: Instance; token: string };
let pool: pg.Pool;
let app: FastifyInstance;
let curator: Who;
let alice: Who;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/episodes", headers: auth(token), payload });
const postRun = (extra: Record<string, unknown> = {}) =>
  post(curator.token, { kind: "asf_run", repo_key: REPO, ref: "run_1", content: RUN, metadata: META, ...extra });
const search = (token: string, q: string) =>
  app.inject({ method: "GET", url: `/v1/search?q=${encodeURIComponent(q)}&source=history`, headers: auth(token) });
const count = async (table: string) => Number((await pool.query(`select count(*) from ${table}`)).rows[0].count);
const jobCount = () => count("distill_jobs");

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate settings, llm_calls, reviews, anchors, facts, episodes, distill_jobs, repos, instances cascade");
  app = buildApp(pool, { version: "test", secretKey: KEY, embedder: new FakeEmbedder(), distillClaimWaitMs: 50 });
  curator = await createInstance(pool, { name: "factory", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  await pool.query("insert into repos (key) values ($1)", [REPO]);
});
afterEach(async () => {
  await app.close();
});

describe("POST /v1/episodes kind=asf_run", () => {
  it("201 and a run record: no distill job, no candidate", async () => {
    const first = await postRun();
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({ episode: { id: expect.any(String), created_at: expect.any(String) }, deduped: false });
    expect(await jobCount()).toBe(0);
    expect(await count("facts")).toBe(0);
    const { rows } = await pool.query("select content, session_id, metadata from episodes where kind = 'asf_run'");
    expect(rows).toEqual([{ content: RUN, session_id: null, metadata: META }]);

    // Another run of the same repo is a new episode.
    expect((await postRun({ ref: "run_2" })).statusCode).toBe(201);
    expect(await count("episodes")).toBe(2);
  });

  it("a repost is 200 deduped: same episode, metadata replaced, content as first posted, still no job", async () => {
    const first = (await postRun()).json();
    const meta = { merged_at: "2026-11-02T08:30:00+01:00", title: "Nightly invoice export (v2)", paths: ["src/export.ts", "src/jobs.ts"] };
    const again = await postRun({ content: `${RUN}\nretried`, metadata: meta });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ episode: first.episode, deduped: true });
    const { rows } = await pool.query("select id, content, metadata from episodes where kind = 'asf_run'");
    expect(rows).toEqual([{ id: first.episode.id, content: RUN, metadata: meta }]);
    expect(await jobCount()).toBe(0);
  });

  it("a repost with bad metadata is 400 and leaves the original episode untouched", async () => {
    const first = (await postRun()).json();
    const bad = await postRun({ metadata: { merged_at: "not-a-date" } });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error).toBe("metadata.merged_at must be an ISO time");
    const { rows } = await pool.query("select id, metadata from episodes where kind = 'asf_run'");
    expect(rows).toEqual([{ id: first.episode.id, metadata: META }]);
  });

  it("400 unless metadata has an ISO merged_at and typed pr_url, title and paths (at most 500)", async () => {
    const bad = async (metadata: unknown) => {
      const res = await postRun({ metadata });
      expect(res.statusCode, res.body).toBe(400);
      return res.json().error;
    };
    expect(await bad(undefined)).toBe("asf_run needs metadata.merged_at");
    expect(await bad({ title: "x" })).toBe("asf_run needs metadata.merged_at");
    expect(await bad({ merged_at: "yesterday" })).toBe("metadata.merged_at must be an ISO time");
    expect(await bad({ merged_at: "2026-13-01T00:00:00Z" })).toBe("metadata.merged_at must be an ISO time");
    expect(await bad({ merged_at: 1762000000 })).toBe("metadata.merged_at must be an ISO time");
    expect(await bad({ ...META, pr_url: 9 })).toBe("metadata.pr_url must be a string");
    expect(await bad({ ...META, title: ["x"] })).toBe("metadata.title must be a string");
    expect(await bad({ ...META, paths: "src/export.ts" })).toBe("metadata.paths must be an array of strings");
    expect(await bad({ ...META, paths: [1] })).toBe("metadata.paths must be an array of strings");
    const many = Array.from({ length: 501 }, (_, i) => `src/f${i}.ts`);
    expect(await bad({ ...META, paths: many })).toBe("metadata.paths has more than 500 entries");
    expect(await count("episodes")).toBe(0);
    expect((await postRun({ metadata: { ...META, paths: many.slice(0, 500) } })).statusCode).toBe(201);
    expect((await postRun({ ref: "run_2", metadata: { merged_at: "2026-11-01T12:00" } })).statusCode).toBe(201);
  });

  it("400 for an unregistered repo or a missing ref; 413 over 200 KiB", async () => {
    const unknown = await postRun({ repo_key: "gh/acme/nope" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("unknown repo_key");
    expect((await post(curator.token, { kind: "asf_run", repo_key: REPO, content: RUN })).statusCode).toBe(400);
    expect((await postRun({ ref: "" })).statusCode).toBe(400);
    expect((await postRun({ ref: "  " })).statusCode).toBe(400);
    const noRepo = await post(curator.token, { kind: "asf_run", ref: "run_1", content: RUN });
    expect(noRepo.statusCode).toBe(400);
    expect(noRepo.json().error).toBe("asf_run needs repo_key and ref");
    expect((await postRun({ content: "x".repeat(200 * 1024 + 1) })).statusCode).toBe(413);
    expect((await postRun({ content: "x".repeat(200 * 1024) })).statusCode).toBe(201);
    // Multi-byte characters count as bytes: 70k three-byte characters is over the limit.
    expect((await postRun({ ref: "run_3", content: "€".repeat(70_000) })).statusCode).toBe(413);
    expect(await count("episodes")).toBe(1);
  });

  it("turn and session still need a session_id", async () => {
    expect((await post(alice.token, { kind: "session", content: "user: hi" })).statusCode).toBe(400);
    expect((await post(alice.token, { kind: "turn", content: "user: hi" })).statusCode).toBe(400);
    expect((await post(alice.token, { kind: "session", session_id: "s1", content: "user: hi" })).statusCode).toBe(201);
  });
});

describe("search source=history", () => {
  it("another user finds an asf_run; session episodes stay their owner's", async () => {
    expect((await postRun()).statusCode).toBe(201);
    await post(curator.token, { kind: "session", session_id: "s1", content: "user: the replica export is jon's secret" });
    await post(alice.token, { kind: "session", session_id: "s2", content: "user: alice muses about the replica" });

    const asAlice = (await search(alice.token, "replica")).json().results;
    expect(asAlice.map((r: { ref: string | null; session_id: string | null }) => r.ref ?? r.session_id).sort()).toEqual(["run_1", "s2"]);
    expect(asAlice.every((r: { source: string }) => r.source === "history")).toBe(true);

    const asJon = (await search(curator.token, "replica")).json().results;
    expect(asJon.map((r: { ref: string | null; session_id: string | null }) => r.ref ?? r.session_id).sort()).toEqual(["run_1", "s1"]);
  });

  it("asf_run hits carry title, pr_url and merged_at; session hits don't", async () => {
    expect((await postRun()).statusCode).toBe(201);
    await post(alice.token, { kind: "session", session_id: "s2", content: "user: alice muses about the replica" });
    const hits = (await search(alice.token, "replica")).json().results;
    const run = hits.find((r: { ref: string | null }) => r.ref === "run_1");
    expect(run).toMatchObject({ source: "history", repo_key: REPO, title: META.title, pr_url: META.pr_url, merged_at: META.merged_at });
    const session = hits.find((r: { session_id: string | null }) => r.session_id === "s2");
    expect(session).not.toHaveProperty("title");
    expect(session).not.toHaveProperty("merged_at");
  });
});

describe("distill", () => {
  it("the trigger no longer queues asf_run episodes; a session still is", async () => {
    await pool.query(`insert into episodes (kind, repo_key, ref, content) values ('asf_run', $1, 'direct', 'run log')`, [REPO]);
    expect(await jobCount()).toBe(0);
    await post(alice.token, { kind: "session", session_id: "s1", content: "user: hi" });
    expect(await jobCount()).toBe(1);
  });
});
