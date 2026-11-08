import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createFact, staleSql, type FactInput } from "../src/facts.js";
import type { EmbedWorker } from "../src/jobs/embed.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };

const KEY = "gh/acme/proj";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });
const get = (token: string, url: string) => app.inject({ url, headers: auth(token) });
const curate = (id: string, body: Record<string, unknown>, token = curator.token) => post(token, `/v1/facts/${id}/curate`, body);

async function fact(input: Partial<FactInput> & { text: string }, who = curator.instance) {
  const { fact } = await createFact(pool, { kind: "convention", scope: `repo:${KEY}`, origin: "authored", ...input }, who);
  return fact.id;
}
/** A fact recorded `days` ago, never used. */
async function old(text: string, days = 90, input: Partial<FactInput> = {}) {
  const id = await fact({ text, ...input });
  await pool.query(`update facts set recorded_at = now() - make_interval(days => $2) where id = $1`, [id, days]);
  return id;
}
const set = (id: string, sql: string) => pool.query(`update facts set ${sql} where id = $1`, [id]);
const row = async (id: string) =>
  (await pool.query("select status, status_note, pinned, kept_at, metadata, supersedes from facts where id = $1", [id])).rows[0];
const reviews = async (id: string) =>
  (await pool.query("select action, note, new_text, reviewer_user_id from reviews where fact_id = $1 order by created_at, id", [id])).rows;
const staleIds = async () => {
  const r = await get(curator.token, "/v1/facts/stale");
  expect(r.statusCode, r.body).toBe(200);
  return r.json().facts.map((f: { id: string }) => f.id);
};

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, repos, instances cascade");
  app = buildApp(pool, { version: "test", embedder: new FakeEmbedder(), minSimilarity: 0.5 });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
});

describe("GET /v1/facts/stale", () => {
  it("lists only active, unpinned facts idle past the window, longest idle first", async () => {
    const stale = await old("Invoices round half-even", 90);
    const staler = await old("Webhooks retry three times", 200);
    await set(await old("Used last week", 90), "last_used_at = now() - interval '7 days'");
    await set(await old("Pinned rule", 90), "pinned = true");
    await set(await old("Kept recently", 90), "kept_at = now() - interval '3 days'");
    const cand = await fact({ text: "A candidate" }, alice.instance);
    await set(cand, "recorded_at = now() - interval '90 days'");
    await set(await old("Retracted long ago", 90), "status = 'retracted'");
    await fact({ text: "Recorded today" });
    await set(await fact({ text: "Alice's own note", scope: "personal:alice" }, alice.instance), "recorded_at = now() - interval '90 days'");
    // Old last_used_at but a newer kept_at, and vice versa: the later of the two counts.
    await set(await old("Kept after its last use", 300), "last_used_at = now() - interval '200 days', kept_at = now() - interval '1 day'");
    await set(await old("Used after its keep", 300), "kept_at = now() - interval '200 days', last_used_at = now() - interval '1 day'");

    const r = await get(curator.token, "/v1/facts/stale");
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.stale_days).toBe(60);
    expect(body.has_more).toBe(false);
    expect(body.facts.map((f: { id: string }) => f.id)).toEqual([staler, stale]);
    expect(body.facts[1]).toMatchObject({ use_count: 0, cite_count: 0, last_used_at: null, pinned: false, idle_days: 90 });
  });

  it("an old fact used inside the window is not stale; one used before it is", async () => {
    const recent = await old("Recently used", 300);
    await set(recent, "last_used_at = now() - interval '59 days'");
    const long = await old("Used long ago", 300);
    await set(long, "last_used_at = now() - interval '61 days', use_count = 4, cite_count = 1");
    const r = await get(curator.token, "/v1/facts/stale");
    expect(r.json().facts).toEqual([expect.objectContaining({ id: long, use_count: 4, cite_count: 1, idle_days: 61 })]);
  });

  it("pages with limit/offset, filters by repo_key, and honors staleDays", async () => {
    const a = await old("A oldest", 300);
    const b = await old("B middle", 200);
    const c = await old("C other repo", 100, { scope: "repo:gh/acme/other" });
    let r = await get(curator.token, "/v1/facts/stale?limit=2");
    expect(r.json()).toMatchObject({ has_more: true });
    expect(r.json().facts.map((f: { id: string }) => f.id)).toEqual([a, b]);
    r = await get(curator.token, "/v1/facts/stale?limit=2&offset=2");
    expect(r.json().facts.map((f: { id: string }) => f.id)).toEqual([c]);
    r = await get(curator.token, `/v1/facts/stale?repo_key=${encodeURIComponent(KEY)}`);
    expect(r.json().facts.map((f: { id: string }) => f.id)).toEqual([a, b]);

    await app.close();
    app = buildApp(pool, { version: "test", staleDays: 150 });
    r = await get(curator.token, "/v1/facts/stale");
    expect(r.json().stale_days).toBe(150);
    expect(r.json().facts.map((f: { id: string }) => f.id)).toEqual([a, b]);
  });

  it("is curator only", async () => {
    const r = await get(alice.token, "/v1/facts/stale");
    expect(r.statusCode).toBe(403);
  });
});

describe("stale flag on list and detail", () => {
  it("is true only for active, unpinned, idle facts", async () => {
    const stale = await old("Stale one", 90);
    const pinned = await old("Pinned one", 90);
    await set(pinned, "pinned = true");
    const fresh = await fact({ text: "Fresh one" });
    const retracted = await old("Retracted one", 90);
    await set(retracted, "status = 'retracted'");
    const r = await get(curator.token, "/v1/facts");
    const byId = Object.fromEntries(r.json().facts.map((f: { id: string; stale: boolean; pinned: boolean }) => [f.id, f]));
    expect(byId[stale]).toMatchObject({ stale: true, pinned: false });
    expect(byId[pinned]).toMatchObject({ stale: false, pinned: true });
    expect(byId[fresh]).toMatchObject({ stale: false });
    expect(byId[retracted]).toMatchObject({ stale: false });
    const d = await get(curator.token, `/v1/facts/${stale}`);
    expect(d.json().fact).toMatchObject({ stale: true, pinned: false });
  });
});

describe("POST /v1/facts/:id/curate", () => {
  it("keep restarts the idle time and clears metadata.correction", async () => {
    const id = await old("Keep me", 90);
    await set(id, `metadata = '{"asked": true, "correction": {"by": "x"}}'`);
    const r = await curate(id, { action: "keep", note: "still true" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().fact).toMatchObject({ id, status: "active", metadata: { asked: true } });
    expect(r.json().fact.kept_at).not.toBeNull();
    const f = await row(id);
    expect(f.kept_at).not.toBeNull();
    expect(f.metadata).toEqual({ asked: true });
    expect(await reviews(id)).toContainEqual({ action: "keep", note: "still true", new_text: null, reviewer_user_id: "jon" });
    expect(await staleIds()).toEqual([]);
  });

  it("pin and unpin", async () => {
    const id = await old("Pin me", 90);
    let r = await curate(id, { action: "pin" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().fact.pinned).toBe(true);
    expect((await row(id)).pinned).toBe(true);
    expect(await staleIds()).toEqual([]);
    r = await curate(id, { action: "unpin" });
    expect(r.json().fact.pinned).toBe(false);
    expect((await row(id)).pinned).toBe(false);
    expect(await staleIds()).toEqual([id]);
    expect((await reviews(id)).map((v) => v.action)).toEqual(["approve", "pin", "unpin"]);
  });

  it("fix creates a fact with the old kind, scope and locus that supersedes it", async () => {
    const id = await old("Deploys go out on Tuesdays", 90, { kind: "decision", locus: ["deploy/"] });
    await pool.query(`insert into anchors (fact_id, path) values ($1, 'deploy/README.md')`, [id]);
    const r = await curate(id, { action: "fix", new_text: "Deploys  go out on Thursdays", note: "moved" });
    expect(r.statusCode, r.body).toBe(200);
    const { fact, new_fact } = r.json();
    expect(fact).toMatchObject({ id, status: "superseded" });
    expect(new_fact).toMatchObject({ text: "Deploys go out on Thursdays", kind: "decision", scope: `repo:${KEY}`, locus: ["deploy/"], status: "active" });
    expect((await row(new_fact.id)).supersedes).toBe(id);
    expect((await pool.query("select 1 from anchors where fact_id = $1", [new_fact.id])).rowCount).toBe(0);
    expect(await reviews(id)).toContainEqual({ action: "fix", note: "moved", new_text: "Deploys go out on Thursdays", reviewer_user_id: "jon" });
  });

  it("fix to text that is already a fact is a 409 and leaves the fact alone", async () => {
    const id = await old("Deploys go out on Tuesdays", 90);
    await fact({ text: "Deploys go out on Thursdays" });
    const r = await curate(id, { action: "fix", new_text: "deploys go out on thursdays" });
    expect(r.statusCode).toBe(409);
    expect((await row(id)).status).toBe("active");
    expect((await reviews(id)).map((v) => v.action)).toEqual(["approve"]);
  });

  it("fix needs new_text", async () => {
    const id = await old("Something", 90);
    expect((await curate(id, { action: "fix" })).statusCode).toBe(400);
    expect((await curate(id, { action: "bogus" })).statusCode).toBe(400);
  });

  it("fix kicks the embed worker; keep, pin, unpin and retire do not", async () => {
    let kicks = 0;
    const worker = { kick: () => kicks++, stop: async () => {}, lastError: () => null } as EmbedWorker;
    app = buildApp(pool, { version: "test", embedder: new FakeEmbedder(), worker });
    const id = await old("Something old", 90);
    await curate(id, { action: "keep" });
    await curate(id, { action: "pin" });
    await curate(id, { action: "unpin" });
    expect(kicks).toBe(0);
    await curate(id, { action: "fix", new_text: "Something new" });
    expect(kicks).toBe(1);
    const other = await old("Another", 90);
    await curate(other, { action: "retire" });
    expect(kicks).toBe(1);
  });

  it("retire retracts with the note, or 'stale'", async () => {
    const a = await old("Retire me", 90);
    const b = await old("Retire me too", 90);
    let r = await curate(a, { action: "retire", note: "service removed" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().fact).toMatchObject({ status: "retracted", status_note: "retired: service removed" });
    r = await curate(b, { action: "retire" });
    expect((await row(b))).toMatchObject({ status: "retracted", status_note: "retired: stale" });
    expect(await reviews(a)).toContainEqual({ action: "retire", note: "service removed", new_text: null, reviewer_user_id: "jon" });
    expect((await reviews(b)).map((v) => v.action)).toEqual(["approve", "retire"]);
    expect(await staleIds()).toEqual([]);
  });

  it("409 on a fact that isn't active, 404 on none, 403 for members", async () => {
    const sup = await old("Superseded one", 90);
    await set(sup, "status = 'superseded'");
    const ret = await old("Retracted one", 90);
    await set(ret, "status = 'retracted'");
    const cand = await fact({ text: "A candidate" }, alice.instance);
    for (const id of [sup, ret, cand]) {
      for (const action of ["keep", "pin", "unpin", "retire"]) expect((await curate(id, { action })).statusCode).toBe(409);
      expect((await curate(id, { action: "fix", new_text: `new text for ${id}` })).statusCode).toBe(409);
    }
    expect((await reviews(sup)).length).toBe(1);
    expect((await row(ret)).status).toBe("retracted");

    expect((await curate("00000000-0000-4000-8000-000000000000", { action: "keep" })).statusCode).toBe(404);
    const personal = await fact({ text: "Alice's note", scope: "personal:alice" }, alice.instance);
    expect((await curate(personal, { action: "keep" })).statusCode).toBe(404);

    const id = await old("Member can't", 90);
    expect((await curate(id, { action: "keep" }, alice.token)).statusCode).toBe(403);
    expect((await curate(id, { action: "retire" }, alice.token)).statusCode).toBe(403);
    expect((await row(id)).status).toBe("active");
  });
});

describe("config", () => {
  const base = { DATABASE_URL: "postgres://x" };
  it("HIVE_STALE_DAYS defaults to 60 and must be a positive integer", () => {
    expect(loadConfig(base).staleDays).toBe(60);
    expect(loadConfig({ ...base, HIVE_STALE_DAYS: "30" }).staleDays).toBe(30);
    for (const bad of ["0", "-5", "1.5", "abc"]) expect(() => loadConfig({ ...base, HIVE_STALE_DAYS: bad })).toThrow(/HIVE_STALE_DAYS/);
    expect(() => staleSql(1.5)).toThrow();
  });
});
