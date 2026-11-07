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
const DIALOG = `assistant: Plan: add a nightly export of invoices, read from the primary database.
user: no, run the export from the replica: the export query locks the invoices table.`;
const META = { author: "jon", gate: "after_plan" };
const USAGE = { model: "claude-test", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0.001, duration_ms: 50 };

type Who = { instance: Instance; token: string };
let pool: pg.Pool;
let embedder: FakeEmbedder;
let app: FastifyInstance;
let curator: Who;
let alice: Who;
let worker: Who;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/episodes", headers: auth(token), payload });
const postDialog = (extra: Record<string, unknown> = {}) =>
  post(curator.token, { kind: "asf_dialog", repo_key: REPO, ref: "run_1/after_plan", content: DIALOG, metadata: META, ...extra });
const search = (token: string, q: string) =>
  app.inject({ method: "GET", url: `/v1/search?q=${encodeURIComponent(q)}&source=history`, headers: auth(token) });
const count = async (table: string) => Number((await pool.query(`select count(*) from ${table}`)).rows[0].count);
const claim = () => app.inject({ method: "POST", url: "/v1/worker/distill/claim", headers: auth(worker.token) });
const complete = (id: string, facts: unknown[]) =>
  app.inject({ method: "POST", url: `/v1/worker/distill/${id}/complete`, headers: auth(worker.token), payload: { facts, usage: USAGE } });

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate settings, llm_calls, reviews, anchors, facts, episodes, distill_jobs, repos, instances cascade");
  embedder = new FakeEmbedder();
  app = buildApp(pool, { version: "test", secretKey: KEY, embedder, distillClaimWaitMs: 50 });
  curator = await createInstance(pool, { name: "factory", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  worker = await createInstance(pool, { name: "hive-worker", userId: "hive", role: "worker" });
  await pool.query("insert into repos (key) values ($1)", [REPO]);
  await app.inject({ method: "PUT", url: "/v1/settings/agent-credential", headers: auth(curator.token), payload: { credential: "sk-ant-oat01-x" } });
});
afterEach(async () => {
  await app.close();
});

describe("POST /v1/episodes kind=asf_dialog", () => {
  it("201, no session_id needed, and a distill job at priority 0", async () => {
    const res = await postDialog();
    expect(res.statusCode, res.body).toBe(201);
    const { episode } = res.json();
    expect(res.json()).toEqual({ episode: { id: expect.any(String), created_at: expect.any(String) }, deduped: false });
    const { rows } = await pool.query("select episode_id, priority from distill_jobs");
    expect(rows).toEqual([{ episode_id: episode.id, priority: 0 }]);
  });

  it("a repost is 200 deduped: content and metadata unchanged, still one job", async () => {
    const first = (await postDialog()).json();
    const again = await postDialog({ content: `${DIALOG}\nuser: and retry twice.`, metadata: { author: "alice" } });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ episode: first.episode, deduped: true });
    const { rows } = await pool.query("select id, content, metadata from episodes where kind = 'asf_dialog'");
    expect(rows).toEqual([{ id: first.episode.id, content: DIALOG, metadata: META }]);
    expect(await count("distill_jobs")).toBe(1);

    // Another ref, or the same ref in another repo, is a new episode.
    expect((await postDialog({ ref: "run_1/q1" })).statusCode).toBe(201);
    await pool.query("insert into repos (key) values ('gh/acme/web')");
    expect((await postDialog({ repo_key: "gh/acme/web" })).statusCode).toBe(201);
    expect(await count("distill_jobs")).toBe(3);
  });

  it("400 without a registered repo_key, a non-blank ref, a user line or metadata.author; 413 over 200 KiB", async () => {
    const bad = async (payload: Record<string, unknown>, extra = true) => {
      const res = extra ? await postDialog(payload) : await post(curator.token, payload);
      expect(res.statusCode, res.body).toBe(400);
      return res.json().error;
    };
    expect(await bad({ kind: "asf_dialog", ref: "r", content: DIALOG, metadata: META }, false)).toBe("asf_dialog needs repo_key and ref");
    expect(await bad({ kind: "asf_dialog", repo_key: REPO, content: DIALOG, metadata: META }, false)).toBe("asf_dialog needs repo_key and ref");
    expect(await bad({ ref: "" })).toBe("asf_dialog needs repo_key and ref");
    expect(await bad({ ref: "  " })).toBe("asf_dialog needs repo_key and ref");
    expect(await bad({ repo_key: "gh/acme/nope" })).toBe("unknown repo_key");
    expect(await bad({ content: "assistant: a plan\nno user here" })).toBe('asf_dialog content needs a line starting with "user: "');
    expect(await bad({ content: "assistant: user: hidden" })).toBe('asf_dialog content needs a line starting with "user: "');
    expect(await bad({ metadata: undefined })).toBe("asf_dialog needs metadata.author");
    expect(await bad({ metadata: { author: "" } })).toBe("asf_dialog needs metadata.author");
    expect(await bad({ metadata: { author: "  " } })).toBe("asf_dialog needs metadata.author");
    expect(await bad({ metadata: { author: 7 } })).toBe("asf_dialog needs metadata.author");
    const big = await postDialog({ content: `user: ${"x".repeat(200 * 1024)}` });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe("asf_dialog content is over 204800 bytes");
    expect(await count("episodes")).toBe(0);
    expect(await count("distill_jobs")).toBe(0);
  });
});

describe("distill an asf_dialog", () => {
  it("keeps a fact quoting the user line and drops one quoting the assistant line", async () => {
    await postDialog();
    const res = await claim();
    expect(res.statusCode, res.body).toBe(200);
    const { job, episode } = res.json();
    expect(episode).toMatchObject({ kind: "asf_dialog", repo_key: REPO, remember_request: false, personal_scope: null });
    const done = await complete(job.id, [
      { text: "The invoice export runs from the replica, because it locks the invoices table.", kind: "decision", scope: `repo:${REPO}`, quote: "run the export from the replica" },
      { text: "The invoice export reads from the primary database.", kind: "decision", scope: `repo:${REPO}`, quote: "read from the primary database" },
    ]);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result).toMatchObject({
      created: [expect.any(String)],
      dropped: [{ text: "The invoice export reads from the primary database.", reason: "non_user_quote" }],
      dropped_non_user_quote: 1,
    });
  });
});

/** A unit vector at cosine `cos` to `vecAt(1)`. */
const vecAt = (cos: number) => [cos, Math.sqrt(1 - cos * cos), ...new Array<number>(766).fill(0)];

describe("distill: the same quote again is the same fact", () => {
  const SCOPE = `repo:${REPO}`;
  const QUOTE = "run the export from the replica";
  const A = "The invoice export runs from the replica.";
  const B = "Invoice exports read from the replica, not the primary.";

  /** Post `content` under `ref`, claim its job and complete it with one fact. */
  async function distill(ref: string, text: string, quote = QUOTE, content = DIALOG, scope = SCOPE) {
    expect((await postDialog({ ref, content })).statusCode).toBe(201);
    const { job } = (await claim()).json();
    const res = await complete(job.id, [{ text, kind: "decision", scope, quote }]);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().result;
  }
  const anchors = async () =>
    (await pool.query("select f.text, count(a.*)::int as n from facts f join anchors a on a.fact_id = f.id group by f.id, f.text order by f.text")).rows;

  it("one gate note under two refs, paraphrased at cosine 0.88: one candidate, two anchors", async () => {
    embedder.fixed.set(A, vecAt(1)).set(B, vecAt(0.88));
    const first = await distill("run_1/after_plan", A);
    const second = await distill("run_1/q1", B);
    expect(second).toMatchObject({ created: [], anchored: first.created });
    expect(await anchors()).toEqual([{ text: A, n: 2 }]);
  });

  it("at cosine 0.79 (under 0.80) the same quote is two candidates", async () => {
    embedder.fixed.set(A, vecAt(1)).set(B, vecAt(0.79));
    await distill("run_1/after_plan", A);
    const second = await distill("run_1/q1", B);
    expect(second).toMatchObject({ created: [expect.any(String)], anchored: [] });
    expect(await count("facts")).toBe(2);
  });

  it("two decisions both quoting 'Yes.' at cosine 0.76 are two candidates", async () => {
    const yes1 = "Use the replica for the invoice export.";
    const yes2 = "Retry the invoice export twice.";
    embedder.fixed.set(yes1, vecAt(1)).set(yes2, vecAt(0.76));
    await distill("run_1/q1", yes1, "Yes.", "assistant: Run the export from the replica?\nuser: Yes.");
    const second = await distill("run_1/q2", yes2, "Yes.", "assistant: Retry the export twice on failure?\nuser: Yes.");
    expect(second).toMatchObject({ created: [expect.any(String)], anchored: [] });
    expect(await count("facts")).toBe(2);
  });

  it("embedder down: the same exchange is one fact; another question or another scope is not", async () => {
    embedder.fail = true;
    const first = await distill("run_1/after_plan", A);
    expect(await distill("run_1/q1", B)).toMatchObject({ created: [], anchored: first.created });
    // the same words, answering another question
    const other = `assistant: Plan: add a nightly export of payments.\nuser: no, run the export from the replica: the export query locks the invoices table.`;
    expect(await distill("run_1/q2", B, QUOTE, other)).toMatchObject({ created: [expect.any(String)], anchored: [] });
    // the same exchange, in another scope
    expect(await distill("run_1/q3", B, QUOTE, DIALOG, "global")).toMatchObject({ created: [expect.any(String)], anchored: [] });
    expect(await count("facts")).toBe(3);
  });

  it("a rejected fact quoted again gains an anchor and stays retracted: not back for review", async () => {
    embedder.fixed.set(A, vecAt(1)).set(B, vecAt(0.88));
    const [id] = (await distill("run_1/after_plan", A)).created;
    const rej = await app.inject({ method: "POST", url: `/v1/facts/${id}/review`, headers: auth(curator.token), payload: { action: "reject" } });
    expect(rej.statusCode, rej.body).toBe(200);
    expect(await distill("run_1/q1", B)).toMatchObject({ created: [], anchored: [id] });
    expect((await pool.query("select status from facts where id = $1", [id])).rows[0].status).toBe("retracted");
    expect(await anchors()).toEqual([{ text: A, n: 2 }]);
  });

  it("a superseded fact quoted again is a new candidate", async () => {
    embedder.fixed.set(A, vecAt(1)).set(B, vecAt(0.88));
    const [id] = (await distill("run_1/after_plan", A)).created;
    await pool.query("update facts set status = 'superseded' where id = $1", [id]);
    expect(await distill("run_1/q1", B)).toMatchObject({ created: [expect.any(String)], anchored: [] });
    expect(await count("facts")).toBe(2);
  });

  it("in the same batch, a later fact on the same quote anchors to the one just created", async () => {
    embedder.fixed.set(A, vecAt(1)).set(B, vecAt(0.88));
    expect((await postDialog({ ref: "run_1/after_plan" })).statusCode).toBe(201);
    const { job } = (await claim()).json();
    const res = await complete(job.id, [
      { text: A, kind: "decision", scope: SCOPE, quote: QUOTE },
      { text: B, kind: "decision", scope: SCOPE, quote: QUOTE },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const { result } = res.json();
    expect(result).toMatchObject({ created: [expect.any(String)], anchored: [result.created[0]] });
    expect(await anchors()).toEqual([{ text: A, n: 2 }]);
  });
});

describe("search source=history", () => {
  it("another user finds an asf_dialog, with ref and author on the hit", async () => {
    expect((await postDialog()).statusCode).toBe(201);
    const hits = (await search(alice.token, "replica")).json().results;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: "history", repo_key: REPO, ref: "run_1/after_plan", author: "jon" });
    expect(hits[0]).not.toHaveProperty("title");
  });
});
