import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact, type FactInput } from "../src/facts.js";
import { createTeam, setMember } from "../src/teams.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };

const KEY = "gh/acme/proj";
const CURATOR_KEYS = ["waiting", "waiting_latest_at", "out_of_date", "stale_days", "month"];
const get = (token: string, url: string) => app.inject({ url, headers: { authorization: `Bearer ${token}` } });
async function home(token = curator.token) {
  const res = await get(token, "/v1/home");
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function fact(input: Partial<FactInput> & { text: string }, who = curator.instance) {
  const { fact } = await createFact(pool, { kind: "convention", scope: `repo:${KEY}`, origin: "authored", ...input }, who);
  return fact.id;
}
const set = (id: string, sql: string) => pool.query(`update facts set ${sql} where id = $1`, [id]);
/** Noon UTC on the 15th of last month: always before this month starts. */
function lastMonth(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15, 12)).toISOString();
}
async function llmCall(job: string, cost: number, at: string | null, episodeId: string | null = null) {
  await pool.query(
    "insert into llm_calls (job, model, est_cost_usd, episode_id, created_at) values ($1, 'm', $2, $3, coalesce($4, now()))",
    [job, cost, episodeId, at],
  );
}
async function episode(): Promise<string> {
  const { rows } = await pool.query("insert into episodes (kind, content) values ('session', 'x') returning id");
  return rows[0].id;
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, repos, teams, instances cascade");
  app = buildApp(pool, { version: "test" });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
});

describe("GET /v1/home", () => {
  it("an empty Hive is zeros, [] and nulls", async () => {
    expect(await home()).toEqual({
      facts: { live: 0, by_level: [] },
      recent: [],
      repos: { count: 0, last_read_at: null, problems: 0 },
      teams: { count: 0 },
      waiting: 0,
      waiting_latest_at: null,
      out_of_date: 0,
      stale_days: 60,
      month: { cost_usd: 0, conversations: 0, proposed: 0 },
    });
  });

  it("a member gets none of the curator keys", async () => {
    await fact({ text: "Shared waiting fact", scope: "global" }, alice.instance);
    await llmCall("distill", 1.5, null);
    const h = await home(alice.token);
    for (const k of CURATOR_KEYS) expect(h).not.toHaveProperty(k);
    expect(Object.keys(h).sort()).toEqual(["facts", "recent", "repos", "teams"]);
  });

  it("counts live facts by level; the caller's own personal facts are personal, another user's are in no count", async () => {
    await fact({ text: "Repo fact one" });
    await fact({ text: "Repo fact two" });
    await fact({ text: "Global fact", scope: "global" });
    await fact({ text: "Jon's own fact", scope: "personal:jon" });
    await fact({ text: "Alice's own fact", scope: "personal:alice" }, alice.instance);
    await fact({ text: "Alice's other fact", scope: "personal:alice" }, alice.instance);
    const retired = await fact({ text: "Retired fact", scope: "global" });
    await set(retired, "status = 'retracted'");
    await fact({ text: "Alice proposes this", scope: "global" }, alice.instance); // a candidate

    const h = await home();
    expect(h.facts).toEqual({
      live: 4,
      by_level: [
        { scope: `repo:${KEY}`, count: 2 },
        { scope: "global", count: 1 },
        { scope: "personal", count: 1 },
      ],
    });
    expect(h.recent.map((f: { text: string }) => f.text)).not.toContain("Alice's own fact");
    const a = await home(alice.token);
    expect(a.facts.by_level).toEqual([
      { scope: "personal", count: 2 },
      { scope: `repo:${KEY}`, count: 2 },
      { scope: "global", count: 1 },
    ]);

    // Each level's count is the Facts list's total for it.
    for (const { scope, count } of h.facts.by_level) {
      const r = await get(curator.token, `/v1/facts?status=active&scope=${encodeURIComponent(scope)}&limit=1`);
      expect(r.json().total).toBe(count);
    }
    expect((await get(curator.token, "/v1/facts?status=active&limit=1")).json().total).toBe(h.facts.live);
  });

  it("recent is the Facts list's first three live facts, labelled the same way", async () => {
    await createTeam(pool, "billing", "Billing");
    for (const [i, scope] of ["global", `repo:${KEY}`, "team:billing", "personal:jon", "global"].entries()) {
      const id = await fact({ text: `Live fact number ${i}`, scope });
      await set(id, `recorded_at = now() - make_interval(mins => ${10 - i})`);
    }
    // Newer than all of those, but not live: neither belongs under "Recently added".
    await fact({ text: "Newest, still waiting for review", scope: "global" }, alice.instance);
    await set(await fact({ text: "Newest, already retired", scope: "global" }), "status = 'retracted'");
    const h = await home();
    const list = (await get(curator.token, "/v1/facts?status=active&limit=3")).json();
    expect(h.recent).toHaveLength(3);
    expect(h.recent).toEqual(list.facts);
    expect(h.recent[2]).toMatchObject({ level: "team", team: "billing", team_name: "Billing" });
  });

  it("waiting and out_of_date match the review queue and the stale list", async () => {
    await fact({ text: "Alice proposes one", scope: "global" }, alice.instance);
    const later = await fact({ text: "Alice proposes two" }, alice.instance);
    await set(later, "recorded_at = now() + interval '1 minute'");
    const own = await fact({ text: "Alice's own candidate", scope: "personal:alice", origin: "distilled" }, alice.instance);
    await set(own, "status = 'candidate'");
    for (const t of ["Old fact one", "Old fact two", "Old pinned fact"]) {
      const id = await fact({ text: t });
      await set(id, `recorded_at = now() - interval '90 days'${t.includes("pinned") ? ", pinned = true" : ""}`);
    }

    const h = await home();
    const queue = (await get(curator.token, "/v1/review/queue?limit=100")).json();
    const stale = (await get(curator.token, "/v1/facts/stale?limit=200")).json();
    expect(h.waiting).toBe(2);
    expect(h.waiting).toBe(queue.candidates.length);
    expect(new Date(h.waiting_latest_at).getTime()).toBe(
      Math.max(...queue.candidates.map((c: { recorded_at: string }) => new Date(c.recorded_at).getTime())),
    );
    expect(h.out_of_date).toBe(2);
    expect(h.out_of_date).toBe(stale.facts.length);
    expect(h.stale_days).toBe(stale.stale_days);
  });

  it("month counts only this month's proposed facts, cost and conversations", async () => {
    const [e1, e2, old] = [await episode(), await episode(), await episode()];
    await llmCall("distill", 0.25, null, e1);
    await llmCall("distill", 0.5, null, e1);
    await llmCall("distill", 0.125, null, e2);
    await llmCall("embed", 0, null);
    // Indexing a conversation is not learning from it.
    await llmCall("embed", 0, null, await episode());
    await llmCall("distill", 9, lastMonth(), old);
    await fact({ text: "Proposed this month", scope: "global", origin: "distilled" });
    await fact({ text: "Also proposed this month", origin: "distilled" });
    const before = await fact({ text: "Proposed last month", origin: "distilled" });
    await set(before, `recorded_at = '${lastMonth()}'`);
    await fact({ text: "Authored this month" });

    expect((await home()).month).toEqual({ cost_usd: 0.875, conversations: 2, proposed: 2 });
  });

  it("repos: how many, when last read, and how many have a problem", async () => {
    await pool.query(
      `insert into repos (key, last_ingested_at, ingest_error) values
         ('gh/a/one', '2026-01-01T00:00:00Z', null),
         ('gh/a/two', '2026-02-01T00:00:00Z', 'clone failed'),
         ('gh/a/three', null, null)`,
    );
    expect((await home(alice.token)).repos).toEqual({ count: 3, last_read_at: "2026-02-01T00:00:00.000Z", problems: 1 });
  });

  it("teams: every team for a curator, the caller's own for a member", async () => {
    await createTeam(pool, "billing", "Billing");
    await createTeam(pool, "platform", "Platform");
    await createTeam(pool, "growth", "Growth");
    await setMember(pool, "billing", "alice", "member");
    expect((await home()).teams).toEqual({ count: 3 });
    expect((await home(alice.token)).teams).toEqual({ count: 1 });
  });
});
