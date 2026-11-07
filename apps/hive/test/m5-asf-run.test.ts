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
const USAGE = { model: "claude-test", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0.001, duration_ms: 50 };

type Who = { instance: Instance; token: string };
let pool: pg.Pool;
let app: FastifyInstance;
let curator: Who;
let alice: Who;
let worker: Who;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/episodes", headers: auth(token), payload });
const postRun = (extra: Record<string, unknown> = {}) =>
  post(curator.token, { kind: "asf_run", repo_key: REPO, ref: "run_1", content: RUN, ...extra });
const search = (token: string, q: string) =>
  app.inject({ method: "GET", url: `/v1/search?q=${encodeURIComponent(q)}&source=history`, headers: auth(token) });
const jobCount = async () => Number((await pool.query("select count(*) from distill_jobs")).rows[0].count);

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
  worker = await createInstance(pool, { name: "hive-worker", userId: "hive", role: "worker" });
  await pool.query("insert into repos (key) values ($1)", [REPO]);
});
afterEach(async () => {
  await app.close();
});

describe("POST /v1/episodes kind=asf_run", () => {
  it("201 and one distill job; a repost of the same run is 200 deduped and queues nothing", async () => {
    const first = await postRun();
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({ episode: { id: expect.any(String), created_at: expect.any(String) }, deduped: false });
    expect(await jobCount()).toBe(1);

    const again = await postRun({ content: `${RUN}\nretried` });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ episode: first.json().episode, deduped: true });
    expect(await jobCount()).toBe(1);
    const { rows } = await pool.query("select content, session_id from episodes where kind = 'asf_run'");
    expect(rows).toEqual([{ content: RUN, session_id: null }]);

    // Another run of the same repo is a new episode.
    expect((await postRun({ ref: "run_2" })).statusCode).toBe(201);
    expect(await jobCount()).toBe(2);
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
    expect(await jobCount()).toBe(1);
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
});

describe("distill", () => {
  it("claim then complete: the candidate is in the review queue, anchored to the run", async () => {
    await app.inject({ method: "PUT", url: "/v1/settings/agent-credential", headers: auth(curator.token), payload: { credential: "sk-ant-oat01-x" } });
    const episode = (await postRun()).json().episode;
    const claim = await app.inject({ method: "POST", url: "/v1/worker/distill/claim", headers: auth(worker.token) });
    expect(claim.statusCode, claim.body).toBe(200);
    expect(claim.json().episode).toEqual({ id: episode.id, kind: "asf_run", repo_key: REPO, content: RUN });

    const quote = "exports run from the replica, never the primary, because the export query locks the invoices table";
    const facts = [{ text: "Invoice exports read from the replica because the export query locks the invoices table.", kind: "decision", scope: `repo:${REPO}`, quote }];
    const done = await app.inject({
      method: "POST", url: `/v1/worker/distill/${claim.json().job.id}/complete`, headers: auth(worker.token), payload: { facts, usage: USAGE },
    });
    expect(done.statusCode, done.body).toBe(200);

    const queue = await app.inject({ method: "GET", url: "/v1/review/queue", headers: auth(curator.token) });
    const [candidate, ...rest] = queue.json().candidates;
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({ text: facts[0]!.text, scope: `repo:${REPO}`, origin: "distilled", status: "candidate" });
    expect(candidate.anchors).toEqual([expect.objectContaining({ episode_id: episode.id, quote, repo_key: REPO })]);
  });
});
