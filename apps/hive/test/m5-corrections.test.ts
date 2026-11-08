import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact, flagCorrection, type FactInput } from "../src/facts.js";
import { freshDb } from "./helpers.js";

const KEY = randomBytes(32);
const REPO = "gh/acme/api";
const SCOPE = `repo:${REPO}`;
const USAGE = { model: "claude-test", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0.001, duration_ms: 50 };

type Who = { instance: Instance; token: string };
let pool: pg.Pool;
let app: FastifyInstance;
let curator: Who;
let alice: Who;
let bob: Who;
let worker: Who;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });
const episode = (token: string, payload: Record<string, unknown>) => post(token, "/v1/episodes", payload);
const turn = (token: string, user: string, assistant: string, metadata: Record<string, unknown> = {}, session_id = "s1") =>
  episode(token, { kind: "turn", session_id, repo_key: REPO, content: `user: ${user}\nassistant: ${assistant}`, metadata });
const queue = async (qs = "") => {
  const res = await app.inject({ url: `/v1/review/queue${qs}`, headers: auth(curator.token) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const correction = async (id: string) =>
  (await pool.query<{ metadata: { correction?: Record<string, unknown> } }>("select metadata from facts where id = $1", [id])).rows[0]!
    .metadata.correction ?? null;

async function fact(input: Partial<FactInput> & { text: string }, who = curator.instance) {
  return (await createFact(pool, { kind: "convention", scope: SCOPE, origin: "authored", ...input }, who)).fact.id;
}

let distilled = 0;
/** Post an episode, claim its job with `related` = [target], and complete it with one new fact replacing target. */
async function distill(payload: Record<string, unknown>, target: string, quote: string, token = curator.token) {
  const ep = await episode(token, payload);
  expect(ep.statusCode, ep.body).toBe(201);
  const claimed = await app.inject({ method: "POST", url: "/v1/worker/distill/claim", headers: auth(worker.token) });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const { job } = claimed.json();
  await pool.query("update distill_jobs set related_ids = $2 where id = $1", [job.id, [target]]);
  const done = await post(worker.token, `/v1/worker/distill/${job.id}/complete`, {
    facts: [{ text: `The invoice export runs from the replica (${++distilled}).`, kind: "decision", scope: SCOPE, quote, replaces: target }],
    usage: USAGE,
  });
  expect(done.statusCode, done.body).toBe(200);
  const candidate = done.json().result.created[0] as string;
  expect((await pool.query("select metadata from facts where id = $1", [candidate])).rows[0].metadata).toEqual({ replaces: target });
  return { episode_id: ep.json().episode.id as string, candidate };
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate settings, llm_calls, reviews, anchors, facts, episodes, distill_jobs, repos, instances cascade");
  app = buildApp(pool, { version: "test", secretKey: KEY, distillClaimWaitMs: 50 });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
  worker = await createInstance(pool, { name: "hive-worker", userId: "hive", role: "worker" });
  await pool.query("insert into repos (key) values ($1)", [REPO]);
  await app.inject({ method: "PUT", url: "/v1/settings/agent-credential", headers: auth(curator.token), payload: { credential: "sk-ant-oat01-x" } });
});
afterEach(async () => {
  await app.close();
});

describe("a distilled correction of a cited fact", () => {
  it("a session that cited the fact before the quoted user line flags it with the candidate", async () => {
    const old = await fact({ text: "The invoice export reads from the primary database." });
    const content = `user: where does the invoice export read from?
assistant: From the primary database [hive:${old.slice(0, 8)}].
user: no, run the export from the replica: it locks the invoices table.
assistant: Noted.`;
    const { episode_id, candidate } = await distill({ kind: "session", session_id: "s1", repo_key: REPO, content }, old, "run the export from the replica");
    expect(await correction(old)).toEqual({
      text: "no, run the export from the replica: it locks the invoices table.",
      episode_id,
      candidate_id: candidate,
      at: expect.any(String),
    });

    const q = await queue();
    expect(q.flagged).toHaveLength(1);
    expect(q.flagged[0]).toMatchObject({
      id: old,
      text: "The invoice export reads from the primary database.",
      status: "active",
      correction: { candidate_id: candidate, episode_id },
      replacing: { id: candidate, text: expect.stringMatching(/^The invoice export runs from the replica/) },
    });
  });

  it("an asf_dialog flags it too; no citation, or one only after the quoted line, does not", async () => {
    const old = await fact({ text: "The invoice export reads from the primary database." });
    const cite = `[hive:${old.slice(0, 8)}]`;
    await distill(
      { kind: "asf_dialog", repo_key: REPO, ref: "run_1/after_plan", metadata: { author: "jon" },
        content: `assistant: Plan: read from the primary ${cite.toUpperCase()}.\nuser: no, run the export from the replica.` },
      old, "run the export from the replica",
    );
    expect(await correction(old)).toMatchObject({ text: "no, run the export from the replica." });
    await pool.query("update facts set metadata = '{}'");

    await distill({ kind: "session", session_id: "s2", repo_key: REPO,
      content: "assistant: From the primary database.\nuser: no, run the export from the replica." }, old, "run the export from the replica");
    expect(await correction(old)).toBeNull();
    await distill({ kind: "session", session_id: "s3", repo_key: REPO,
      content: `user: no, run the export from the replica.\nassistant: Right, unlike ${cite}.` }, old, "run the export from the replica");
    expect(await correction(old)).toBeNull();
    expect((await queue()).flagged).toEqual([]);
  });

  it("the latest flag wins; a retracted fact is never flagged", async () => {
    const old = await fact({ text: "The invoice export reads from the primary database." });
    const content = (said: string) => `assistant: The primary [hive:${old.slice(0, 8)}].\nuser: ${said}`;
    await distill({ kind: "session", session_id: "s1", repo_key: REPO, content: content("no, run the export from the replica.") }, old, "replica");
    const second = await distill({ kind: "session", session_id: "s2", repo_key: REPO, content: content("not true, use the replica now.") }, old, "use the replica");
    expect(await correction(old)).toMatchObject({ text: "not true, use the replica now.", candidate_id: second.candidate });

    const gone = await fact({ text: "Exports run hourly." });
    await post(curator.token, `/v1/facts/${gone}/retract`, { reason: "wrong" });
    expect(await flagCorrection(pool, gone, { text: "x", episode_id: second.episode_id, candidate_id: null })).toBe(false);
    expect(await correction(gone)).toBeNull();
    expect((await queue()).flagged.map((f: { id: string }) => f.id)).toEqual([old]);
  });

  it("a turn job flags the fact when the previous turn cited it (a plain turn job, queued by hand)", async () => {
    const old = await fact({ text: "The invoice export reads from the primary database." });
    const other = await fact({ text: "Exports run hourly." });
    await turn(curator.token, "q0", "a0", {}, "s1");
    await turn(curator.token, "q", "a", { cited: [old.slice(0, 13).toUpperCase()] }, "s1");
    await turn(alice.token, "q", "a", {}, "s1"); // another instance's turn in the session doesn't count
    const ep = await turn(curator.token, "no, run the export from the replica", "ok", {}, "s1");
    await pool.query("insert into distill_jobs (episode_id) values ($1)", [ep.json().episode.id]);
    const claimed = (await app.inject({ method: "POST", url: "/v1/worker/distill/claim", headers: auth(worker.token) })).json();
    await pool.query("update distill_jobs set related_ids = $2 where id = $1", [claimed.job.id, [old, other]]);
    const facts = [
      { text: "The invoice export runs from the replica.", kind: "decision", scope: SCOPE, quote: "run the export from the replica", replaces: old },
      { text: "Exports run on demand.", kind: "decision", scope: SCOPE, quote: "no, run", replaces: other },
    ];
    const done = await post(worker.token, `/v1/worker/distill/${claimed.job.id}/complete`, { facts, usage: USAGE });
    expect(done.statusCode, done.body).toBe(200);
    expect(await correction(old)).toMatchObject({ text: "no, run the export from the replica", candidate_id: done.json().result.created[0] });
    expect(await correction(other)).toBeNull();
  });

  it("approving the replacing candidate takes the fact out of flagged; rejecting it leaves the flag", async () => {
    const old = await fact({ text: "The invoice export reads from the primary database." });
    const content = `assistant: The primary [hive:${old.slice(0, 8)}].\nuser: no, run the export from the replica.`;
    const { candidate } = await distill({ kind: "session", session_id: "s1", repo_key: REPO, content }, old, "replica");
    expect((await post(curator.token, `/v1/facts/${candidate}/review`, { action: "reject" })).statusCode).toBe(200);
    expect((await queue()).flagged).toMatchObject([{ id: old, replacing: null }]);

    const again = await distill(
      { kind: "session", session_id: "s2", repo_key: REPO, content: `assistant: The primary [hive:${old.slice(0, 8)}].\nuser: the replica, as I said.` },
      old, "the replica, as I said",
    );
    expect((await queue()).flagged).toMatchObject([{ id: old, replacing: { id: again.candidate } }]);
    expect((await post(curator.token, `/v1/facts/${again.candidate}/review`, { action: "approve" })).statusCode).toBe(200);
    expect((await pool.query("select status from facts where id = $1", [old])).rows[0].status).toBe("superseded");
    expect((await queue()).flagged).toEqual([]);
  });
});

describe("a turn marked as a correction", () => {
  it("flags each fact the previous turn of the session cited, with this turn's user text", async () => {
    const a = await fact({ text: "The invoice export reads from the primary database." });
    const b = await fact({ text: "Exports run hourly." });
    const c = await fact({ text: "Exports are CSV." });
    expect((await turn(alice.token, "how do exports work?", "Primary, hourly.", { cited: [a.slice(0, 8), b.slice(0, 13).toUpperCase()] })).statusCode).toBe(201);
    const res = await turn(alice.token, "that's wrong, exports run from the replica", "Sorry.", { correction: true, cited: [c.slice(0, 8)] });
    expect(res.statusCode, res.body).toBe(201);
    const episode_id = res.json().episode.id;
    for (const id of [a, b]) {
      expect(await correction(id)).toEqual({ text: "that's wrong, exports run from the replica", episode_id, candidate_id: null, at: expect.any(String) });
    }
    expect(await correction(c)).toBeNull(); // this turn's own citation is not what it corrects
    const q = await queue();
    expect(q.flagged.map((f: { id: string }) => f.id).sort()).toEqual([a, b].sort());
    expect(q.flagged[0]).toMatchObject({ replacing: null, correction: { candidate_id: null } });
  });

  it("only the previous turn of the same session by the same instance counts; correction must be a boolean", async () => {
    const a = await fact({ text: "The invoice export reads from the primary database." });
    const cited = { cited: [a.slice(0, 8)] };
    await turn(alice.token, "q", "a", cited, "s1");
    await turn(alice.token, "q2", "no citation", {}, "s1");
    await turn(bob.token, "q", "a", cited, "s2");
    await turn(alice.token, "that's wrong", "Sorry.", { correction: true }, "s1"); // previous turn cited nothing
    await turn(alice.token, "that's wrong", "Sorry.", { correction: true }, "s2"); // bob's turn, not alice's
    await turn(alice.token, "that's wrong", "Sorry.", { correction: false }, "s3");
    expect(await correction(a)).toBeNull();

    for (const bad of ["yes", 1, null]) {
      const res = await turn(alice.token, "that's wrong", "Sorry.", { correction: bad });
      expect(res.statusCode, String(bad)).toBe(400);
      expect(res.json().error).toBe("metadata.correction must be a boolean");
    }
    await turn(alice.token, "q", "a", cited, "s4");
    expect((await turn(alice.token, "nope", "ok", { correction: false }, "s4")).statusCode).toBe(201);
    expect(await correction(a)).toBeNull();
  });

  it("resolves prefixes like citations: ambiguous, unknown, candidate and other people's personal facts are skipped", async () => {
    const mine = await fact({ text: "alice's own note", scope: "personal:alice" }, alice.instance);
    const bobs = await fact({ text: "bob's own note", scope: "personal:bob" }, bob.instance);
    const cand = await fact({ text: "a candidate" }, alice.instance);
    const x = await fact({ text: "first" });
    const y = await fact({ text: "second" });
    await pool.query("delete from reviews"); // the curator's self-approves
    await pool.query("update facts set id = $2 where id = $1", [x, "abcd1234-0000-4000-8000-000000000001"]);
    await pool.query("update facts set id = $2 where id = $1", [y, "abcd1234-0000-4000-8000-000000000002"]);
    await turn(alice.token, "q", "a", { cited: [mine.slice(0, 8), bobs.slice(0, 8), cand.slice(0, 8), "abcd1234", "eeee9999"] });
    expect((await turn(alice.token, "not true", "ok", { correction: true })).statusCode).toBe(201);
    expect(await correction(mine)).toMatchObject({ text: "not true" });
    for (const id of [bobs, cand, "abcd1234-0000-4000-8000-000000000001", "abcd1234-0000-4000-8000-000000000002"]) {
      expect(await correction(id)).toBeNull();
    }
    // a curator never sees another user's personal facts in flagged
    expect((await queue()).flagged).toEqual([]);
  });
});

describe("flagged in the queue, and curating clears it", () => {
  async function flagged(text: string, scope = SCOPE) {
    const id = await fact({ text, scope });
    const { rows } = await pool.query("insert into episodes (kind, content) values ('session', 'user: x') returning id");
    await flagCorrection(pool, id, { text: `corrected: ${text}`, episode_id: rows[0].id, candidate_id: null });
    return id;
  }

  it("newest first, up to limit, the scope filter applies, and the text is cut at 500 chars", async () => {
    const first = await flagged("first");
    const second = await flagged("second", "global");
    const third = await flagged("third");
    expect((await queue()).flagged.map((f: { id: string }) => f.id)).toEqual([third, second, first]);
    expect((await queue("?limit=2")).flagged.map((f: { id: string }) => f.id)).toEqual([third, second]);
    expect((await queue(`?scope=${encodeURIComponent(SCOPE)}`)).flagged.map((f: { id: string }) => f.id)).toEqual([third, first]);
    const { rows } = await pool.query("select id from episodes limit 1");
    await flagCorrection(pool, first, { text: "y".repeat(800), episode_id: rows[0].id, candidate_id: null });
    expect(((await correction(first))!.text as string).length).toBe(500);
    expect((await app.inject({ url: "/v1/review/queue", headers: auth(alice.token) })).statusCode).toBe(403);
  });

  it("keep, fix and retire each clear the flag; pin does not", async () => {
    const ids = { keep: await flagged("kept"), fix: await flagged("fixed"), retire: await flagged("retired"), pin: await flagged("pinned") };
    for (const [action, id] of Object.entries(ids)) {
      const body = action === "fix" ? { action, new_text: "fixed, for real" } : { action };
      const res = await post(curator.token, `/v1/facts/${id}/curate`, body);
      expect(res.statusCode, res.body).toBe(200);
      if (action !== "pin") {
        expect(res.json().fact.metadata.correction, action).toBeUndefined();
        expect(await correction(id), action).toBeNull();
      }
    }
    expect(await correction(ids.pin)).not.toBeNull();
    expect((await queue()).flagged.map((f: { id: string }) => f.id)).toEqual([ids.pin]);
  });
});
