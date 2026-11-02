import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { freshDb, TEST_DB_URL } from "./helpers.js";

let pool: pg.Pool;
// The app talks over a session far from UTC, so day buckets only line up if the SQL groups by UTC.
let farPool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let member: { instance: Instance; token: string };

const DAY_MS = 86_400_000;
/** Noon UTC, `back` days ago, and its 'YYYY-MM-DD'. */
function noonUtc(back: number): { at: string; day: string } {
  const d = new Date(Date.now() - back * DAY_MS);
  d.setUTCHours(12, 0, 0, 0);
  return { at: d.toISOString(), day: d.toISOString().slice(0, 10) };
}
const get = (token: string, url: string) => app.inject({ url, headers: { authorization: `Bearer ${token}` } });
async function stats(qs = "") {
  const res = await get(curator.token, `/v1/stats${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function llmCall(job: string, at: string, input: number, output: number, cost: number) {
  await pool.query(
    "insert into llm_calls (job, model, input_tokens, output_tokens, est_cost_usd, created_at) values ($1, 'm', $2, $3, $4, $5)",
    [job, input, output, cost, at],
  );
}
let n = 0;
async function fact(scope: string, status: string, origin: string, at: string) {
  n++;
  await pool.query(
    `insert into facts (text, kind, scope, origin, status, content_hash, recorded_at) values ($1, 'decision', $2, $3, $4, $5, $6)`,
    [`fact ${n}`, scope, origin, status, `h${n}`, at],
  );
}

beforeAll(async () => {
  pool = await freshDb();
  farPool = new pg.Pool({ connectionString: TEST_DB_URL, max: 2, options: "-c timezone=Pacific/Kiritimati" });
});
afterAll(async () => {
  await farPool.end();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, distill_jobs, reviews, anchors, facts, episodes, instances cascade");
  app = buildApp(farPool, { version: "test" });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  member = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
});

describe("GET /v1/stats", () => {
  it("sums cost per UTC day and job, and per job over the window", async () => {
    const today = noonUtc(0);
    const yesterday = noonUtc(1);
    await llmCall("distill", today.at, 1000, 200, 0.0125);
    await llmCall("distill", today.at, 500, 100, 0.0075);
    await llmCall("embed", today.at, 40, 0, 0);
    await llmCall("distill", yesterday.at, 300, 50, 0.004);
    await llmCall("distill", noonUtc(40).at, 9999, 9999, 9);

    const s = await stats();
    expect(s.days).toBe(30);
    expect(s.cost).toEqual([
      { day: yesterday.day, job: "distill", calls: 1, input_tokens: 300, output_tokens: 50, cost_usd: 0.004 },
      { day: today.day, job: "distill", calls: 2, input_tokens: 1500, output_tokens: 300, cost_usd: 0.02 },
      { day: today.day, job: "embed", calls: 1, input_tokens: 40, output_tokens: 0, cost_usd: 0 },
    ]);
    expect(s.cost_totals).toEqual([
      { job: "distill", calls: 3, input_tokens: 1800, output_tokens: 350, cost_usd: 0.024 },
      { job: "embed", calls: 1, input_tokens: 40, output_tokens: 0, cost_usd: 0 },
    ]);
    expect(typeof s.cost_totals[1].cost_usd).toBe("number");
  });

  it("counts facts by status, origin and folded scope, and per UTC day", async () => {
    const today = noonUtc(0);
    const yesterday = noonUtc(1);
    await fact("global", "active", "authored", today.at);
    await fact("repo:gh/a/b", "candidate", "distilled", today.at);
    await fact("personal:alice", "active", "authored", yesterday.at);
    await fact("personal:bob", "candidate", "distilled", yesterday.at);
    await fact("global", "retracted", "ingested", noonUtc(60).at);

    const s = await stats();
    expect(s.facts.by_status).toEqual({ active: 2, candidate: 2, retracted: 1 });
    expect(s.facts.by_origin).toEqual({ authored: 2, distilled: 2, ingested: 1 });
    expect(s.facts.by_scope).toEqual({ global: 2, personal: 2, "repo:gh/a/b": 1 });
    expect(JSON.stringify(s)).not.toContain("personal:");
    expect(s.facts.per_day).toEqual([
      { day: yesterday.day, count: 2 },
      { day: today.day, count: 2 },
    ]);
    expect(s.backlog).toMatchObject({ candidates: 2, oldest_candidate_at: yesterday.at, distill_queued: 0, oldest_queued_at: null });
  });

  it("lists live workers and the distill queue", async () => {
    const w1 = await createInstance(pool, { name: "worker-a", userId: "svc", role: "worker" });
    const w2 = await createInstance(pool, { name: "worker-b", userId: "svc", role: "worker" });
    const seen = noonUtc(0).at;
    await pool.query("update instances set last_seen_at = $2 where id = $1", [w1.instance.id, seen]);
    await pool.query("update instances set revoked_at = now() where id = $1", [w2.instance.id]);
    await pool.query("insert into episodes (kind, content, created_at) values ('session', 'a', now() - interval '2 hours'), ('session', 'b', now()), ('turn', 'c', now())");
    const { rows } = await pool.query<{ at: Date }>("select min(created_at) as at from distill_jobs");

    const s = await stats();
    expect(s.workers).toEqual([{ id: w1.instance.id, name: "worker-a", last_seen_at: seen }]);
    expect(s.backlog).toMatchObject({ candidates: 0, oldest_candidate_at: null, distill_queued: 2, oldest_queued_at: rows[0]!.at.toISOString() });
  });

  it("days limits the window", async () => {
    await llmCall("distill", noonUtc(0).at, 1, 1, 0.01);
    await llmCall("distill", noonUtc(1).at, 1, 1, 0.02);
    await fact("global", "active", "authored", noonUtc(1).at);
    const s = await stats("?days=1");
    expect(s.days).toBe(1);
    expect(s.cost.map((c: { day: string }) => c.day)).toEqual([noonUtc(0).day]);
    expect(s.cost_totals).toEqual([{ job: "distill", calls: 1, input_tokens: 1, output_tokens: 1, cost_usd: 0.01 }]);
    expect(s.facts.per_day).toEqual([]);
    expect(s.since).toBe(`${noonUtc(0).day}T00:00:00.000Z`);
    expect((await stats("?days=2")).cost_totals[0].calls).toBe(2);
  });

  it("is curator only and checks days", async () => {
    const res = await get(member.token, "/v1/stats");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "only a curator can see stats" });
    expect((await get(curator.token, "/v1/stats?days=0")).statusCode).toBe(400);
    expect((await get(curator.token, "/v1/stats?days=366")).statusCode).toBe(400);
    expect((await get(curator.token, "/v1/stats?days=365")).statusCode).toBe(200);
  });
});
