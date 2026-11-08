import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact, recordUse, type FactInput } from "../src/facts.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let bob: { instance: Instance; token: string };

const KEY = "gh/acme/proj";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });

async function fact(input: Partial<FactInput> & { text: string }, who = curator.instance, id?: string) {
  const { fact } = await createFact(pool, { kind: "convention", scope: `repo:${KEY}`, origin: "authored", ...input }, who);
  if (!id) return fact.id;
  await pool.query("delete from reviews where fact_id = $1", [fact.id]); // the curator's self-approve
  await pool.query("update facts set id = $2 where id = $1", [fact.id, id]);
  return id;
}
async function counts(id: string) {
  const { rows } = await pool.query<{ use_count: number; cite_count: number; last_used_at: Date | null }>(
    "select use_count, cite_count, last_used_at from facts where id = $1",
    [id],
  );
  return rows[0]!;
}
const turn = (token: string, metadata: Record<string, unknown>) =>
  post(token, "/v1/episodes", { kind: "turn", session_id: "s1", content: "user: q\nassistant: a", metadata });

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
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
});

describe("use counts", () => {
  it("a brief and a recall each count a returned fact once; /v1/search does not", async () => {
    const id = await fact({ text: "Invoice totals are rounded half-even per line" });
    const other = await fact({ text: "Webhooks retry three times" });
    expect(await counts(id)).toMatchObject({ use_count: 0, cite_count: 0, last_used_at: null });

    const b = await post(alice.token, "/v1/brief", { task: "invoice rounding", repo_key: KEY });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().facts.map((f: { id: string }) => f.id)).toEqual([id]);
    expect((await counts(id)).use_count).toBe(1);
    expect((await counts(id)).last_used_at).not.toBeNull();

    const r = await app.inject({ url: `/v1/recall?q=invoice%20rounding&repo_key=${encodeURIComponent(KEY)}`, headers: auth(alice.token) });
    expect(r.json().facts.map((f: { id: string }) => f.id)).toEqual([id]);
    expect((await counts(id)).use_count).toBe(2);

    const s = await app.inject({ url: "/v1/search?q=invoice%20rounding", headers: auth(alice.token) });
    expect(s.json().facts.map((f: { id: string }) => f.id)).toEqual([id]);
    expect((await counts(id)).use_count).toBe(2);
    expect((await counts(other)).use_count).toBe(0);
  });

  it("recordUse counts active facts once per call, skips others, and only logs a failure", async () => {
    const id = await fact({ text: "Invoice totals are rounded half-even per line" });
    const cand = await fact({ text: "a candidate" }, alice.instance);
    const warned: unknown[] = [];
    const log = { warn: (obj: unknown) => void warned.push(obj) };
    await recordUse(pool, [id, id, cand], log);
    expect((await counts(id)).use_count).toBe(1);
    expect((await counts(cand)).use_count).toBe(0);
    await recordUse(pool, ["not-a-uuid"], log);
    expect(warned).toHaveLength(1);
  });

  it("list and detail show the counts", async () => {
    const id = await fact({ text: "Invoice totals are rounded half-even per line" });
    await pool.query("update facts set use_count = 3, cite_count = 2, last_used_at = now() where id = $1", [id]);
    const list = await app.inject({ url: "/v1/facts", headers: auth(alice.token) });
    expect(list.json().facts[0]).toMatchObject({ id, use_count: 3, cite_count: 2 });
    expect(list.json().facts[0].last_used_at).toBeTruthy();
    const detail = await app.inject({ url: `/v1/facts/${id}`, headers: auth(alice.token) });
    expect(detail.json().fact).toMatchObject({ id, use_count: 3, cite_count: 2 });
  });
});

describe("citations on a turn", () => {
  it("counts a cited fact once per turn, by any prefix case", async () => {
    const id = await fact({ text: "Invoice totals are rounded half-even per line" });
    const res = await turn(alice.token, { cited: [id.slice(0, 8), id.slice(0, 8).toUpperCase(), id] });
    expect(res.statusCode, res.body).toBe(201);
    expect(await counts(id)).toMatchObject({ use_count: 0, cite_count: 1 });
    expect((await counts(id)).last_used_at).not.toBeNull();
    await turn(alice.token, { cited: [id.slice(0, 13).toUpperCase()] });
    expect((await counts(id)).cite_count).toBe(2);
  });

  it("ignores ambiguous, unknown, non-active and other people's personal prefixes", async () => {
    const a = await fact({ text: "first fact" }, curator.instance, "abcd1234-0000-4000-8000-000000000001");
    const b = await fact({ text: "second fact" }, curator.instance, "abcd1234-0000-4000-8000-000000000002");
    const mine = await fact({ text: "alice's own note", scope: "personal:alice" }, alice.instance, "bbbb1111-0000-4000-8000-000000000001");
    const bobs = await fact({ text: "bob's own note", scope: "personal:bob" }, bob.instance, "cccc2222-0000-4000-8000-000000000001");
    const cand = await fact({ text: "a candidate" }, alice.instance, "dddd3333-0000-4000-8000-000000000001");
    const res = await turn(alice.token, { cited: ["abcd1234", "eeee9999", "bbbb1111", "cccc2222", "dddd3333"] });
    expect(res.statusCode, res.body).toBe(201);
    expect((await counts(a)).cite_count).toBe(0);
    expect((await counts(b)).cite_count).toBe(0);
    expect((await counts(mine)).cite_count).toBe(1);
    expect((await counts(bobs)).cite_count).toBe(0);
    expect((await counts(cand)).cite_count).toBe(0);
    // a longer prefix that tells the two apart counts
    await turn(alice.token, { cited: ["abcd1234-0000-4000-8000-0000000000"] });
    expect((await counts(a)).cite_count).toBe(0);
    await turn(alice.token, { cited: ["abcd1234-0000-4000-8000-000000000002"] });
    expect((await counts(b)).cite_count).toBe(1);
  });

  it("rejects a bad cited list with 400 and records nothing", async () => {
    const id = await fact({ text: "Invoice totals are rounded half-even per line" });
    const p = id.slice(0, 8);
    for (const cited of [p, [p, 5], Array(21).fill(p), ["zzzzzzzz"], ["zz"], [id.slice(0, 7)], [`${p}%`]]) {
      const res = await turn(alice.token, { cited });
      expect(res.statusCode, JSON.stringify(cited)).toBe(400);
    }
    expect((await pool.query("select 1 from episodes")).rowCount).toBe(0);
    expect((await counts(id)).cite_count).toBe(0);
    expect((await turn(alice.token, { cited: Array(20).fill(p) })).statusCode).toBe(201);
    expect((await turn(alice.token, { cited: [] })).statusCode).toBe(201);
  });

  it("a failure to record citations still records the turn", async () => {
    const id = await fact({ text: "Invoice totals are rounded half-even per line" });
    await pool.query("alter table facts rename column cite_count to cite_count_x");
    try {
      expect((await turn(alice.token, { cited: [id.slice(0, 8)] })).statusCode).toBe(201);
    } finally {
      await pool.query("alter table facts rename column cite_count_x to cite_count");
    }
    expect((await pool.query("select 1 from episodes")).rowCount).toBe(1);
  });

  it("only a turn's cited counts", async () => {
    const id = await fact({ text: "Invoice totals are rounded half-even per line" });
    const res = await post(alice.token, "/v1/episodes", {
      kind: "session", session_id: "s1", content: "user: q\nassistant: a", metadata: { cited: [id.slice(0, 8)] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((await counts(id)).cite_count).toBe(0);
  });
});
