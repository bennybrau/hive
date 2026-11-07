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
const TURN = `user: remember this: we deploy to Cloud Run from main, never by hand.
assistant: Noted. Every SQL migration is numbered too.
user: and I prefer tabs.`;
const USAGE = { model: "claude-test", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0.001, duration_ms: 50 };

type Who = { instance: Instance; token: string };
let pool: pg.Pool;
let embedder: FakeEmbedder;
let app: FastifyInstance;
let curator: Who;
let alice: Who;
let worker: Who;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const postEpisode = (who: Who, kind: string, metadata?: Record<string, unknown>, content = TURN) =>
  app.inject({ method: "POST", url: "/v1/episodes", headers: auth(who.token), payload: { kind, session_id: "s1", content, repo_key: REPO, metadata } });
const flag = (who: Who) => postEpisode(who, "turn", { remember_request: true });
const remember = (who: Who, text: string, scope = `repo:${REPO}`, anchors?: unknown[]) =>
  app.inject({ method: "POST", url: "/v1/facts", headers: auth(who.token), payload: { text, kind: "decision", scope, anchors } });
const claim = () => app.inject({ method: "POST", url: "/v1/worker/distill/claim", headers: auth(worker.token) });
const complete = (id: string, facts: unknown[]) =>
  app.inject({ method: "POST", url: `/v1/worker/distill/${id}/complete`, headers: auth(worker.token), payload: { facts, usage: USAGE } });
const getFact = (who: Who, id: string) => app.inject({ method: "GET", url: `/v1/facts/${id}`, headers: auth(who.token) });
const allFacts = async () =>
  (await pool.query<{ id: string; text: string; origin: string; status: string; metadata: { asked?: boolean } }>(
    "select id, text, origin, status, metadata from facts order by recorded_at, id",
  )).rows;
const anchorCount = async (id: string) => Number((await pool.query("select count(*) from anchors where fact_id = $1", [id])).rows[0].count);
const fact = (text: string, scope = `repo:${REPO}`, quote = "we deploy to Cloud Run from main, never by hand.") => ({ text, kind: "decision", scope, quote });

/** Flag a turn as `who` and claim its job. */
async function flagAndClaim(who: Who) {
  expect((await flag(who)).statusCode).toBe(201);
  const res = await claim();
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

function build(e: FakeEmbedder | null) {
  app = buildApp(pool, { version: "test", secretKey: KEY, embedder: e, distillClaimWaitMs: 50 });
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate settings, llm_calls, reviews, anchors, facts, episodes, distill_jobs, repos, instances cascade");
  embedder = new FakeEmbedder();
  build(embedder);
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  worker = await createInstance(pool, { name: "hive-worker", userId: "hive", role: "worker" });
  await app.inject({ method: "PUT", url: "/v1/settings/agent-credential", headers: auth(curator.token), payload: { credential: "sk-ant-oat01-x" } });
});
afterEach(async () => {
  await app.close();
});

describe("enqueue", () => {
  it("queues a flagged turn at priority 1, and no other turn", async () => {
    await postEpisode(alice, "turn");
    await postEpisode(alice, "turn", { remember_request: false });
    await postEpisode(alice, "turn", { remember_request: "yes" });
    const flagged = (await flag(alice)).json().episode;
    const session = (await postEpisode(alice, "session")).json().episode;
    const { rows } = await pool.query("select episode_id, priority from distill_jobs order by created_at");
    expect(rows).toEqual([
      { episode_id: flagged.id, priority: 1 },
      { episode_id: session.id, priority: 0 },
    ]);
  });

  it("a session is always priority 0, even carrying remember_request metadata", async () => {
    const session = (await postEpisode(alice, "session", { remember_request: true })).json().episode;
    const { rows } = await pool.query("select episode_id, priority from distill_jobs order by created_at");
    expect(rows).toEqual([{ episode_id: session.id, priority: 0 }]);
  });

  it("an asf_run is never queued, even carrying remember_request metadata", async () => {
    await pool.query(`insert into episodes (kind, repo_key, ref, content, metadata) values ('asf_run', $1, 'run_1', $2, '{"remember_request":true}')`, [REPO, TURN]);
    expect((await pool.query("select count(*)::int as n from distill_jobs")).rows[0].n).toBe(0);
  });

  it("a flagged turn is claimed before an older session, and says it is a remember job", async () => {
    const session = (await postEpisode(alice, "session")).json().episode;
    const turn = (await flag(alice)).json().episode;
    const first = (await claim()).json();
    expect(first.episode).toEqual({ id: turn.id, kind: "turn", repo_key: REPO, content: TURN, remember_request: true, personal_scope: "personal:alice" });
    const second = (await claim()).json();
    expect(second.episode).toMatchObject({ id: session.id, remember_request: false, personal_scope: null });
  });
});

describe("complete a remember job", () => {
  it("a curator's repo fact is active, self-approved, authored by them and asked; a personal one has no review", async () => {
    const { job } = await flagAndClaim(curator);
    const res = await complete(job.id, [
      fact("We deploy to Cloud Run from main, never by hand."),
      fact("Jon prefers tabs.", "personal:jon", "I prefer tabs."),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const [id, personal] = res.json().result.created;
    const got = (await getFact(curator, id)).json();
    expect(got.fact).toMatchObject({ origin: "authored", status: "active", author_user_id: "jon", metadata: { asked: true } });
    expect(got.reviews).toEqual([expect.objectContaining({ action: "approve", reviewer_user_id: "jon", note: "authored by curator" })]);
    const mine = (await getFact(curator, personal)).json();
    expect(mine.fact).toMatchObject({ status: "active", metadata: { asked: true } });
    expect(mine.reviews).toEqual([]); // personal scope needs no review
    const author = await pool.query("select author_instance_id from facts where id = $1", [id]);
    expect(author.rows[0].author_instance_id).toBe(curator.instance.id);
  });

  it("a member's repo fact is a candidate; their personal fact is active; neither has a review", async () => {
    const { job } = await flagAndClaim(alice);
    const res = await complete(job.id, [
      fact("We deploy to Cloud Run from main, never by hand."),
      fact("Alice prefers tabs.", "personal:alice", "I prefer tabs."),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result.created).toHaveLength(2);
    const made = (await allFacts()).map((f) => [f.text, f.origin, f.status, f.metadata]).sort();
    expect(made).toEqual([
      ["Alice prefers tabs.", "authored", "active", { asked: true }],
      ["We deploy to Cloud Run from main, never by hand.", "authored", "candidate", { asked: true }],
    ]);
    expect((await pool.query("select 1 from reviews")).rowCount).toBe(0);
  });

  it("a hash dupe of what the agent remembered in the turn: one fact, two anchors, now asked", async () => {
    const mine = (await remember(alice, "We deploy to Cloud Run from main, never by hand.", `repo:${REPO}`, [{ repo_key: REPO, path: "deploy.sh" }])).json().fact;
    expect(mine.metadata).toEqual({});
    const { job } = await flagAndClaim(alice);
    const res = await complete(job.id, [fact("we deploy to Cloud Run  from main, never by hand.")]);
    expect(res.json().result).toMatchObject({ created: [], anchored: [mine.id] });
    expect((await allFacts()).map((f) => [f.id, f.metadata])).toEqual([[mine.id, { asked: true }]]);
    expect(await anchorCount(mine.id)).toBe(2);
  });

  it("a curator anchoring to their own prior active fact gets no second review row", async () => {
    const curated = await complete((await flagAndClaim(curator)).job.id, [fact("We deploy to Cloud Run from main, never by hand.")]);
    const [mineId] = curated.json().result.created;
    const res = await complete((await flagAndClaim(curator)).job.id, [fact("we deploy to Cloud Run  from main, never by hand.")]);
    expect(res.json().result).toMatchObject({ created: [], anchored: [mineId] });
    expect(await anchorCount(mineId)).toBe(2);
    expect((await pool.query("select action from reviews where fact_id = $1", [mineId])).rows).toEqual([
      { action: "approve" },
    ]);
  });

  it("a cosine dupe of an un-embedded fact from the turn: embedded here, one fact, two anchors", async () => {
    const mine = (await remember(alice, "Releases ship to production via Cloud Run.", `repo:${REPO}`, [{ repo_key: REPO, path: "deploy.sh" }])).json().fact;
    const { job } = await flagAndClaim(alice);
    const res = await complete(job.id, [fact("We deploy to Cloud Run from main.")]);
    expect(res.json().result).toMatchObject({ created: [], anchored: [mine.id] });
    expect((await allFacts()).map((f) => [f.id, f.metadata])).toEqual([[mine.id, { asked: true }]]);
    expect(await anchorCount(mine.id)).toBe(2);
    const emb = await pool.query("select embedding is not null as e from facts where id = $1", [mine.id]);
    expect(emb.rows[0].e).toBe(true);
  });

  it("quoting the words of another instance's candidate (cosine 0.85): anchored to it, now asked", async () => {
    const A = "Deploys go to Cloud Run from main only.";
    const B = "We deploy to Cloud Run from main, never by hand.";
    embedder.fixed.set(A, [1, 0, ...new Array<number>(766).fill(0)]).set(B, [0.85, Math.sqrt(1 - 0.85 * 0.85), ...new Array<number>(766).fill(0)]);
    await postEpisode(alice, "session");
    const distilled = await complete((await claim()).json().job.id, [fact(A)]);
    const [candidate] = distilled.json().result.created;
    const res = await complete((await flagAndClaim(curator)).job.id, [fact(B)]);
    expect(res.json().result).toMatchObject({ created: [], anchored: [candidate] });
    expect((await allFacts()).map((f) => [f.id, f.status, f.metadata])).toEqual([[candidate, "candidate", { asked: true }]]);
    expect(await anchorCount(candidate)).toBe(2);
  });

  it("an unrelated fact with an embedder is new, even with a window fact in its scope", async () => {
    await remember(alice, "Invoices are generated nightly by billing.");
    const { job } = await flagAndClaim(alice);
    const res = await complete(job.id, [fact("We deploy to Cloud Run from main.")]);
    expect(res.json().result.created).toHaveLength(1);
  });

  it("with no embedder, takes the window fact in the same scope, one per job fact, never one from before the window", async () => {
    await app.close();
    build(null);
    await remember(alice, "Old: before the previous turn.");
    await postEpisode(alice, "turn"); // previous turn: the window starts here
    const a = (await remember(alice, "Alpha decision.")).json().fact;
    const b = (await remember(alice, "Beta decision.")).json().fact;
    await remember(curator, "Jon's fact in the same window.");
    const { job } = await flagAndClaim(alice);
    const res = await complete(job.id, [
      fact("We deploy to Cloud Run from main."),
      fact("Every SQL migration is numbered.", `repo:${REPO}`, "Every SQL migration is numbered too."),
      fact("A third repo fact.", `repo:${REPO}`, "Every SQL migration is numbered too."),
      fact("Alice prefers tabs.", "personal:alice", "I prefer tabs."),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const result = res.json().result;
    expect(result.anchored).toEqual([a.id, b.id, a.id]);
    expect(result.created).toHaveLength(1); // the personal fact: no window fact in that scope
    const asked = (await allFacts()).filter((f) => f.metadata.asked).map((f) => f.text);
    expect(asked).toEqual(["Alpha decision.", "Beta decision.", "Alice prefers tabs."]);
  });

  it("with no previous turn, the window is the last 15 minutes", async () => {
    await app.close();
    build(null);
    const old = (await remember(alice, "Old decision.")).json().fact;
    await pool.query("update facts set recorded_at = now() - interval '20 minutes' where id = $1", [old.id]);
    const recent = (await remember(alice, "Recent decision.")).json().fact;
    const { job } = await flagAndClaim(alice);
    const res = await complete(job.id, [fact("We deploy to Cloud Run from main.")]);
    expect(res.json().result.anchored).toEqual([recent.id]);
  });

  it("keeps a quote from the assistant's line: the user-turn rule is for session jobs only", async () => {
    const { job } = await flagAndClaim(alice);
    const res = await complete(job.id, [fact("Every SQL migration is numbered.", `repo:${REPO}`, "Every SQL migration is numbered too.")]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toMatchObject({ created: [expect.any(String)], dropped: [], dropped_non_user_quote: 0 });
  });

  it("a session job drops that same assistant quote", async () => {
    await postEpisode(alice, "session");
    const { job } = (await claim()).json();
    const res = await complete(job.id, [fact("Every SQL migration is numbered.", `repo:${REPO}`, "Every SQL migration is numbered too.")]);
    expect(res.json().result).toMatchObject({ created: [], dropped: [{ reason: "non_user_quote" }], dropped_non_user_quote: 1 });
  });

  it("a normal session job is unchanged: distilled candidates, nothing asked", async () => {
    await remember(alice, "Alpha decision.");
    await postEpisode(alice, "session");
    const { job } = (await claim()).json();
    const res = await complete(job.id, [fact("We deploy to Cloud Run from main.")]);
    expect(res.json().result.created).toHaveLength(1);
    const made = (await allFacts()).find((f) => f.id === res.json().result.created[0])!;
    expect(made).toMatchObject({ origin: "distilled", status: "candidate", metadata: {} });
  });
});
