import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { contentHash } from "../src/facts.js";
import { createRepoSync, type RepoSync } from "../src/jobs/repo-sync.js";
import { createTeam } from "../src/teams.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

/** Curate "move": a curator moves an active fact to another level. And GET /v1/repo-keys, the levels to pick from. */
let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let sync: RepoSync;

const KEY = "gh/acme/proj";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const curate = (id: string, body: Record<string, unknown>, token = curator.token) =>
  app.inject({ method: "POST", url: `/v1/facts/${id}/curate`, headers: auth(token), payload: body });

/** A fact written straight into the table, so its scope and status can be anything. */
async function fact(text: string, scope = `repo:${KEY}`, status = "active", author = "jon"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into facts (text, kind, scope, origin, status, author_user_id, content_hash)
     values ($1, 'decision', $2, 'authored', $3, $4, $5) returning id`,
    [text, scope, status, author, contentHash(text, scope)],
  );
  return rows[0]!.id;
}
const row = async (id: string) =>
  (await pool.query("select scope, status, status_note, content_hash, supersedes from facts where id = $1", [id])).rows[0];
const reviewsOf = async (id: string) =>
  (await pool.query("select action, note, reviewer_user_id from reviews where fact_id = $1 order by created_at, id", [id])).rows;

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await app?.close();
  await sync?.stop();
  await pool.end();
});
beforeEach(async () => {
  await app?.close();
  await sync?.stop();
  await pool.query("truncate reviews, anchors, facts, repos, teams, instances cascade");
  sync = createRepoSync(pool, { maxCommits: 500, intervalMin: 0, log: () => {} });
  app = buildApp(pool, { version: "test", embedder: new FakeEmbedder(), repos: { roots: { root: "/repos", hostRoot: "/repos" }, sync } });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  await createTeam(pool, "a", "Team A");
});

describe("POST /v1/facts/:id/curate move", () => {
  it("moves an active fact to global, a team, another repo or the curator's own personal scope", async () => {
    const id = await fact("Invoices round half-even");
    const steps: [string, string][] = [
      ["global", "global"],
      ["team:a", "team:a"],
      ["repo:gh/acme/unregistered", "repo:gh/acme/unregistered"],
      ["personal", "personal:jon"],
      [`repo:${KEY}`, `repo:${KEY}`],
      ["personal:jon", "personal:jon"],
    ];
    let from = `repo:${KEY}`;
    for (const [scope, to] of steps) {
      const res = await curate(id, { action: "move", scope });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ fact: { id, scope: to, status: "active", pinned: false, kept_at: null }, new_fact: null, merged_into: null });
      expect(await row(id)).toMatchObject({ scope: to, status: "active", content_hash: contentHash("Invoices round half-even", to) });
      expect((await reviewsOf(id)).at(-1)).toEqual({ action: "move", note: `moved ${from} → ${to}`, reviewer_user_id: "jon" });
      from = to;
    }
  });

  it("puts the caller's note before the move", async () => {
    const id = await fact("Webhooks retry three times");
    expect((await curate(id, { action: "move", scope: "global", note: "applies everywhere" })).statusCode).toBe(200);
    expect(await reviewsOf(id)).toEqual([{ action: "move", note: `applies everywhere; moved repo:${KEY} → global`, reviewer_user_id: "jon" }]);
  });

  it("merges into an active fact with that text there: anchors move, this one is retracted", async () => {
    const there = await fact("Billing runs nightly", "team:a");
    const id = await fact("Billing runs nightly");
    await pool.query("insert into anchors (fact_id, quote) values ($1, 'billing runs nightly')", [id]);
    const res = await curate(id, { action: "move", scope: "team:a" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ fact: { id, status: "retracted", status_note: `merged into ${there}` }, new_fact: null });
    expect(res.json().merged_into).toMatchObject({ id: there, status: "active", scope: "team:a" });
    expect(res.json().merged_into).not.toHaveProperty("content_hash");
    expect(await row(id)).toMatchObject({ scope: `repo:${KEY}`, status: "retracted" });
    expect((await pool.query("select fact_id from anchors")).rows).toEqual([{ fact_id: there }]);
    expect(await reviewsOf(id)).toEqual([{ action: "move", note: `moved repo:${KEY} → team:a`, reviewer_user_id: "jon" }]);
    expect(await reviewsOf(there)).toEqual([]);
  });

  it("merges into a candidate with that text there: it is activated, supersedes, and gets an approve review", async () => {
    const replaced = await fact("Billing retries once", "global");
    const cand = await fact("Billing retries twice", "global", "candidate", "alice");
    await pool.query("update facts set supersedes = $2 where id = $1", [cand, replaced]);
    const id = await fact("Billing retries twice");
    const res = await curate(id, { action: "move", scope: "global" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().merged_into).toMatchObject({ id: cand, status: "active" });
    expect(await row(cand)).toMatchObject({ status: "active" });
    expect(await row(replaced)).toMatchObject({ status: "superseded" });
    expect(await row(id)).toMatchObject({ status: "retracted", status_note: `merged into ${cand}` });
    expect(await reviewsOf(cand)).toEqual([{ action: "approve", note: `merged from ${id}`, reviewer_user_id: "jon" }]);
  });

  it("409 when that text is a retracted or superseded fact there; nothing changes", async () => {
    for (const status of ["retracted", "superseded"]) {
      const text = `Billing is in UTC (${status})`;
      await fact(text, "global", status);
      const id = await fact(text);
      const res = await curate(id, { action: "move", scope: "global" });
      expect(res.statusCode, res.body).toBe(409);
      expect(await row(id)).toMatchObject({ scope: `repo:${KEY}`, status: "active" });
      expect(await reviewsOf(id)).toEqual([]);
    }
  });

  it("409 when the fact isn't active", async () => {
    for (const status of ["candidate", "retracted", "superseded"]) {
      const id = await fact(`A ${status} fact`, `repo:${KEY}`, status);
      const res = await curate(id, { action: "move", scope: "global" });
      expect(res.statusCode, res.body).toBe(409);
      expect(await row(id)).toMatchObject({ scope: `repo:${KEY}`, status });
    }
  });

  it("400 with no scope, its own scope, another user's personal scope or an unknown one; 404 for an unknown team", async () => {
    const id = await fact("Exports are CSV");
    expect((await curate(id, { action: "move" })).statusCode).toBe(400);
    for (const scope of [`repo:${KEY}`, "personal:alice", "nonsense", "repo:", "repo:has space"]) {
      const res = await curate(id, { action: "move", scope });
      expect(res.statusCode, `${scope}: ${res.body}`).toBe(400);
    }
    const nope = await curate(id, { action: "move", scope: "team:nope" });
    expect(nope.statusCode, nope.body).toBe(404);
    expect(nope.json().error).toMatch(/no such team/);
    expect(await row(id)).toMatchObject({ scope: `repo:${KEY}`, status: "active" });
    expect(await reviewsOf(id)).toEqual([]);
  });

  it("404 for no such fact or another user's personal fact; 403 for a member", async () => {
    expect((await curate("00000000-0000-0000-0000-000000000000", { action: "move", scope: "global" })).statusCode).toBe(404);
    const hers = await fact("Alice's own note", "personal:alice", "active", "alice");
    expect((await curate(hers, { action: "move", scope: "global" })).statusCode).toBe(404);
    const id = await fact("Exports are gzipped");
    expect((await curate(id, { action: "move", scope: "global" }, alice.token)).statusCode).toBe(403);
    expect(await row(id)).toMatchObject({ scope: `repo:${KEY}` });
  });

  it("other curate answers carry no merged_into", async () => {
    const id = await fact("Keep me");
    const res = await curate(id, { action: "keep" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).not.toHaveProperty("merged_into");
  });
});

describe("GET /v1/repo-keys", () => {
  it("lists registered repos and the repo scopes of active or candidate facts, once each, in byte order", async () => {
    await pool.query("insert into repos (key) values ('gh/acme/registered'), ($1)", [KEY]);
    await fact("Proj fact");
    await fact("Unregistered active", "repo:gh/acme/zeta");
    await fact("Unregistered candidate", "repo:Gh/Upper", "candidate", "alice");
    await fact("Only retracted", "repo:gh/acme/gone", "retracted");
    await fact("Only superseded", "repo:gh/acme/old", "superseded");
    await fact("Global fact", "global");
    await fact("Team fact", "team:a");
    for (const who of [curator, alice]) {
      const res = await app.inject({ url: "/v1/repo-keys", headers: auth(who.token) });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ repo_keys: ["Gh/Upper", KEY, "gh/acme/registered", "gh/acme/zeta"] });
    }
  });

  it("needs a token", async () => {
    expect((await app.inject({ url: "/v1/repo-keys" })).statusCode).toBe(401);
  });
});
