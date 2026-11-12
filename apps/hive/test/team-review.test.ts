import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { contentHash } from "../src/facts.js";
import { createTeam, setMember } from "../src/teams.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

/**
 * Teams part 4 (bennybrau/hive#117): a curator shares a candidate on approve (`scope`: global or team:<key>). Review
 * stays curator-only: a team reviewer is a member like any other here.
 */
let pool: pg.Pool;
let app: FastifyInstance;
type Who = { instance: Instance; token: string };
let curator: Who, alice: Who, rita: Who;

const X = "gh/acme/x";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (who: Who, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth(who.token), ...(payload ? { payload } : {}) });
const review = (who: Who, id: string, body: object) => call(who, "POST", `/v1/facts/${id}/review`, body);

/** A fact written straight into the table, so its scope and status can be anything. */
async function fact(text: string, scope: string, status = "candidate", metadata: object = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into facts (text, kind, scope, origin, status, author_user_id, content_hash, metadata)
     values ($1, 'decision', $2, 'distilled', $3, 'alice', $4, $5) returning id`,
    [text, scope, status, contentHash(text, scope), metadata],
  );
  return rows[0]!.id;
}
const row = async (id: string) =>
  (await pool.query("select scope, status, status_note, content_hash, text from facts where id = $1", [id])).rows[0];
const reviewsOf = async (id: string) =>
  (await pool.query("select action, note from reviews where fact_id = $1 order by created_at", [id])).rows;

beforeAll(async () => {
  pool = await freshDb();
  app = buildApp(pool, { version: "test", embedder: new FakeEmbedder() });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  rita = await createInstance(pool, { name: "rita-laptop", userId: "rita" });
  await createTeam(pool, "a", "Team A");
  await setMember(pool, "a", "alice", "member");
  await setMember(pool, "a", "rita", "reviewer");
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("review stays with curators", () => {
  it("a member, even a team reviewer, gets 403 on the queue and on review", async () => {
    const id = await fact("Team A ships on Tuesdays", "team:a");
    for (const who of [alice, rita]) {
      expect((await call(who, "GET", "/v1/review/queue")).statusCode).toBe(403);
      expect((await review(who, id, { action: "approve" })).statusCode).toBe(403);
      expect((await review(who, id, { action: "approve", scope: "team:a" })).statusCode).toBe(403);
    }
    expect((await row(id)).status).toBe("candidate");
  });
});

describe("share-with on approve", () => {
  it("moves a candidate to a team or global: scope and hash change, the note says so, and its old-scope target is superseded", async () => {
    const old = await fact("Invoices are rounded per invoice", `repo:${X}`, "active");
    const toTeam = await fact("Invoices are rounded per line", `repo:${X}`, "candidate", { replaces: old });
    const res = await review(curator, toTeam, { action: "approve", note: "lgtm", scope: "team:a" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ fact: { id: toTeam, scope: "team:a", status: "active" }, merged_into: null });
    expect(await row(toTeam)).toMatchObject({ scope: "team:a", content_hash: contentHash("Invoices are rounded per line", "team:a") });
    expect(await reviewsOf(toTeam)).toEqual([{ action: "approve", note: `lgtm; moved repo:${X} → team:a` }]);
    expect((await row(old)).status).toBe("superseded");

    const toGlobal = await fact("Refunds are never rounded", `repo:${X}`);
    expect((await review(curator, toGlobal, { action: "approve", scope: "global" })).statusCode).toBe(200);
    expect(await row(toGlobal)).toMatchObject({ scope: "global", status: "active", content_hash: contentHash("Refunds are never rounded", "global") });
    expect(await reviewsOf(toGlobal)).toEqual([{ action: "approve", note: `moved repo:${X} → global` }]);
  });

  it("its own scope is no move, and a fix moves with the new text", async () => {
    const stay = await fact("Taxes are added after rounding", `repo:${X}`);
    expect((await review(curator, stay, { action: "approve", scope: `repo:${X}` })).statusCode).toBe(200);
    expect(await row(stay)).toMatchObject({ scope: `repo:${X}`, status: "active" });
    expect(await reviewsOf(stay)).toEqual([{ action: "approve", note: null }]);

    const fixed = await fact("Taxs are added before roundng", `repo:${X}`);
    const res = await review(curator, fixed, { action: "fix", new_text: "Taxes are added before rounding", scope: "team:a" });
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(fixed)).toMatchObject({
      scope: "team:a", status: "active", text: "Taxes are added before rounding",
      content_hash: contentHash("Taxes are added before rounding", "team:a"),
    });
  });

  it("into a scope that already has its text: merged into that fact, anchors moved", async () => {
    const there = await fact("Billing runs nightly", "team:a", "active");
    const cand = await fact("Billing runs nightly", `repo:${X}`);
    await pool.query("insert into anchors (fact_id, quote) values ($1, 'billing runs nightly')", [cand]);
    const res = await review(curator, cand, { action: "approve", scope: "team:a" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().merged_into).toMatchObject({ id: there, status: "active" });
    expect(await row(cand)).toMatchObject({ status: "retracted", status_note: `merged into ${there}`, scope: `repo:${X}` });
    const anchors = await pool.query("select fact_id from anchors where quote = 'billing runs nightly'");
    expect(anchors.rows).toEqual([{ fact_id: there }]);

    // a candidate there is activated with its own review row
    const other = await fact("Billing retries twice", "global");
    const cand2 = await fact("Billing retries twice", `repo:${X}`);
    const res2 = await review(curator, cand2, { action: "approve", scope: "global" });
    expect(res2.json().merged_into).toMatchObject({ id: other, status: "active" });
    expect(await reviewsOf(other)).toEqual([{ action: "approve", note: `merged from ${cand2}` }]);
  });

  it("409 when that text is a retracted fact in the target scope", async () => {
    await fact("Billing is in UTC", "team:a", "retracted");
    const cand = await fact("Billing is in UTC", `repo:${X}`);
    const res = await review(curator, cand, { action: "approve", scope: "team:a" });
    expect(res.statusCode, res.body).toBe(409);
    expect(await row(cand)).toMatchObject({ status: "candidate", scope: `repo:${X}` });
  });

  it("404 for an unknown team, 400 for a personal or unknown scope or a reject with a scope", async () => {
    const cand = await fact("Billing exports CSV", `repo:${X}`);
    const nope = await review(curator, cand, { action: "approve", scope: "team:nope" });
    expect(nope.statusCode, nope.body).toBe(404);
    expect(nope.json().error).toMatch(/no such team/);
    for (const scope of ["personal:jon", "nonsense"]) {
      expect((await review(curator, cand, { action: "approve", scope })).statusCode).toBe(400);
    }
    expect((await review(curator, cand, { action: "reject", scope: "global" })).statusCode).toBe(400);
    expect(await row(cand)).toMatchObject({ status: "candidate", scope: `repo:${X}` });
    expect(await reviewsOf(cand)).toEqual([]);
  });

  it("another repo, registered or not, is a target", async () => {
    const cand = await fact("Billing exports TSV", `repo:${X}`);
    const res = await review(curator, cand, { action: "approve", scope: "repo:gh/acme/other" });
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(cand)).toMatchObject({ status: "active", scope: "repo:gh/acme/other" });
    expect(await reviewsOf(cand)).toEqual([{ action: "approve", note: `moved repo:${X} → repo:gh/acme/other` }]);
  });
});
