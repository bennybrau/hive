import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { contentHash } from "../src/facts.js";
import type { EmbedWorker } from "../src/jobs/embed.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
type Who = { instance: Instance; token: string };
let jon: Who; // curator
let alice: Who; // member
let bob: Who; // member
let robot: Who; // worker

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const getQueue = (who: Who, qs = "") => app.inject({ url: `/v1/review/queue${qs}`, headers: auth(who.token) });
const review = (who: Who, id: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/v1/facts/${id}/review`, headers: auth(who.token), payload: body });

/** A fact as distill or a remember leaves it, written straight to the table. */
async function fact(
  author: Who,
  text: string,
  scope: string,
  over: { status?: string; origin?: string; metadata?: Record<string, unknown>; recorded_at?: string } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into facts (text, kind, scope, origin, status, author_user_id, author_instance_id, content_hash, metadata, recorded_at)
     values ($1, 'convention', $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [text, scope, over.origin ?? "distilled", over.status ?? "candidate", author.instance.user_id, author.instance.id,
     contentHash(text, scope), over.metadata ?? {}, over.recorded_at ?? "2026-11-01T00:00:00Z"],
  );
  return rows[0]!.id;
}
async function row(id: string) {
  return (await pool.query("select status, scope, text, status_note from facts where id = $1", [id])).rows[0];
}
async function reviewsOf(id: string) {
  return (await pool.query("select reviewer_user_id, action from reviews where fact_id = $1 order by created_at", [id])).rows;
}

type Seeded = "aliceOld" | "aliceNote" | "aliceFix" | "bobNote" | "jonNote" | "shared" | "repo" | "flaggedShared" | "flaggedAlice";
let ids: Record<Seeded, string>;

/** Shared and personal candidates of three people, an anchored one, one that replaces a fact, and two flagged facts. */
async function seed() {
  ids = {} as typeof ids;
  ids.aliceOld = await fact(alice, "I run tests with vitest 1", "personal:alice", { status: "active", origin: "authored" });
  ids.aliceNote = await fact(alice, "I prefer tabs over spaces", "personal:alice", { recorded_at: "2026-11-01T01:00:00Z" });
  ids.aliceFix = await fact(alice, "I run tests with vitest 2", "personal:alice", {
    recorded_at: "2026-11-01T02:00:00Z",
    metadata: { replaces: ids.aliceOld },
  });
  ids.bobNote = await fact(bob, "I deploy on Fridays", "personal:bob", { recorded_at: "2026-11-01T03:00:00Z" });
  ids.jonNote = await fact(jon, "I review on Mondays", "personal:jon", { recorded_at: "2026-11-01T04:00:00Z" });
  ids.shared = await fact(alice, "Deploys go through Cloud Run", "global", { recorded_at: "2026-11-01T05:00:00Z", metadata: { asked: true } });
  ids.repo = await fact(bob, "The api repo uses pnpm", "repo:gh/acme/api", { recorded_at: "2026-11-01T06:00:00Z" });
  await pool.query("insert into anchors (fact_id, quote) values ($1, 'I prefer tabs')", [ids.aliceNote]);
  const correction = (text: string) => ({ correction: { text, episode_id: "e1", candidate_id: null, at: "2026-11-02T00:00:00Z" } });
  ids.flaggedShared = await fact(jon, "Billing runs on Fridays", "global", { status: "active", origin: "authored", metadata: correction("not true") });
  ids.flaggedAlice = await fact(alice, "I like dark mode", "personal:alice", { status: "active", origin: "authored", metadata: correction("no, light") });
}

/** The queue with ids named after the seed and dates left out, so it compares across runs. */
function named(body: unknown): unknown {
  const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
  return JSON.parse(JSON.stringify(body), (k, v) => {
    if (typeof v === "string" && byId.has(v)) return byId.get(v);
    if ((k === "recorded_at" || k === "id") && typeof v === "string" && !byId.has(v)) return "<" + k + ">";
    return v;
  });
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, doc_chunks, instances cascade");
  const worker = { kick: () => {}, stop: async () => {}, lastError: () => null } as EmbedWorker;
  app = buildApp(pool, { version: "test", embedder: new FakeEmbedder(), worker });
  jon = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
  robot = await createInstance(pool, { name: "ci", userId: "ci", role: "worker" });
  await seed();
});

describe("a member's queue", () => {
  it("has only their own personal candidates, with anchors and replaces, and nothing flagged", async () => {
    const res = await getQueue(alice);
    expect(res.statusCode, res.body).toBe(200);
    const q = named(res.json()) as { candidates: any[]; flagged: unknown[]; last_distill_at: unknown };
    expect(q.candidates.map((c) => c.id)).toEqual(["aliceNote", "aliceFix"]);
    expect(q.candidates[0].anchors.map((a: { quote: string }) => a.quote)).toEqual(["I prefer tabs"]);
    expect(q.candidates[1].replaces).toMatchObject({ id: "aliceOld", scope: "personal:alice", status: "active" });
    expect(q.flagged).toEqual([]);
    expect(q.last_distill_at).toBeNull();
  });

  it("stays their own whatever the filters ask for", async () => {
    for (const qs of ["?scope=global", "?scope=personal:bob", "?origin=distilled", "?limit=1"]) {
      const res = await getQueue(alice, qs);
      expect(res.statusCode, res.body).toBe(200);
      for (const c of res.json().candidates) expect(c.scope).toBe("personal:alice");
      expect(res.json().flagged).toEqual([]);
    }
    expect((await getQueue(bob)).json().candidates.map((c: { id: string }) => c.id)).toEqual([ids.bobNote]);
  });

  it("is refused to a worker, and so is a review", async () => {
    expect((await getQueue(robot)).statusCode).toBe(403);
    expect((await review(robot, ids.aliceNote, { action: "approve" })).statusCode).toBe(403);
    expect((await row(ids.aliceNote)).status).toBe("candidate");
  });
});

describe("a member deciding", () => {
  it("approves, fixes and rejects their own personal candidates, logged as theirs", async () => {
    const ok = async (id: string, body: Record<string, unknown>) => {
      const res = await review(alice, id, body);
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    expect((await ok(ids.aliceNote, { action: "approve", note: "yes" })).fact).toMatchObject({ status: "active", scope: "personal:alice" });
    const third = await fact(alice, "I write commit messages in English", "personal:alice");
    expect((await ok(third, { action: "fix", new_text: "I write commit messages in plain English" })).fact).toMatchObject({
      status: "active",
      scope: "personal:alice",
      text: "I write commit messages in plain English",
    });
    expect((await ok(ids.aliceFix, { action: "reject", note: "wrong" })).fact.status).toBe("retracted");
    expect(await reviewsOf(ids.aliceNote)).toEqual([{ reviewer_user_id: "alice", action: "approve" }]);
    expect(await reviewsOf(third)).toEqual([{ reviewer_user_id: "alice", action: "fix" }]);
    expect(await reviewsOf(ids.aliceFix)).toEqual([{ reviewer_user_id: "alice", action: "reject" }]);
    expect((await getQueue(alice)).json().candidates).toEqual([]);
  });

  it("approving a candidate that replaces their fact retires it, in their own scope", async () => {
    expect((await review(alice, ids.aliceFix, { action: "approve" })).statusCode).toBe(200);
    expect(await row(ids.aliceOld)).toMatchObject({ status: "superseded", scope: "personal:alice" });
    expect(await row(ids.aliceFix)).toMatchObject({ status: "active", scope: "personal:alice" });
  });

  it("a fix to the text of their own fact merges into it; the same text elsewhere is left alone", async () => {
    const res = await review(alice, ids.aliceNote, { action: "fix", new_text: "I like dark mode" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().merged_into.id).toBe(ids.flaggedAlice);
    const shared = await review(alice, ids.aliceFix, { action: "fix", new_text: "Billing runs on Fridays" });
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json().merged_into).toBeNull();
    expect(await row(ids.aliceFix)).toMatchObject({ status: "active", scope: "personal:alice" });
    expect(await row(ids.flaggedShared)).toMatchObject({ status: "active", scope: "global" });
  });

  it("can't move a fact to another level", async () => {
    for (const scope of ["global", "personal:alice", "personal"]) {
      const res = await review(alice, ids.aliceNote, { action: "approve", scope });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe("members cannot move a fact to another level");
    }
    expect((await row(ids.aliceNote)).status).toBe("candidate");
  });

  it("gets 404 for another person's personal fact, as if it weren't there", async () => {
    for (const id of [ids.bobNote, ids.jonNote]) {
      const res = await review(alice, id, { action: "approve" });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error).toBe("no such fact");
      expect((await row(id)).status).toBe("candidate");
    }
    expect((await review(alice, "00000000-0000-0000-0000-000000000000", { action: "reject" })).statusCode).toBe(404);
  });

  it("gets 403 for a shared fact, their own or not", async () => {
    for (const id of [ids.shared, ids.repo, ids.flaggedShared]) {
      const res = await review(alice, id, { action: "approve" });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("only a curator can review shared facts");
    }
    expect(await row(ids.shared)).toMatchObject({ status: "candidate", scope: "global" });
    expect(await reviewsOf(ids.shared)).toEqual([]);
  });

  it("gets 409 for their own fact that is no longer a candidate", async () => {
    expect((await review(alice, ids.aliceOld, { action: "approve" })).statusCode).toBe(409);
  });
});

describe("a curator's queue", () => {
  it("is what it was before members could review", async () => {
    const res = await getQueue(jon);
    expect(res.statusCode, res.body).toBe(200);
    expect(named(res.json())).toStrictEqual(CURATOR_QUEUE);
  });

  it("still lets the curator decide shared candidates and move them", async () => {
    const res = await review(jon, ids.repo, { action: "approve", scope: "global" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().fact).toMatchObject({ status: "active", scope: "global" });
  });
});

/** GET /v1/review/queue as the curator, on the seed above, taken before members could review. */
const CURATOR_QUEUE = {
  last_distill_at: null,
  candidates: [
    {
      id: "shared",
      text: "Deploys go through Cloud Run",
      kind: "convention",
      scope: "global",
      locus: [],
      origin: "distilled",
      status: "candidate",
      status_note: null,
      author_user_id: "alice",
      recorded_at: "<recorded_at>",
      metadata: { asked: true },
      supersedes: null,
      anchors: [],
      similar: [],
      replaces: null,
    },
    {
      id: "jonNote",
      text: "I review on Mondays",
      kind: "convention",
      scope: "personal:jon",
      locus: [],
      origin: "distilled",
      status: "candidate",
      status_note: null,
      author_user_id: "jon",
      recorded_at: "<recorded_at>",
      metadata: {},
      supersedes: null,
      anchors: [],
      similar: [],
      replaces: null,
    },
    {
      id: "repo",
      text: "The api repo uses pnpm",
      kind: "convention",
      scope: "repo:gh/acme/api",
      locus: [],
      origin: "distilled",
      status: "candidate",
      status_note: null,
      author_user_id: "bob",
      recorded_at: "<recorded_at>",
      metadata: {},
      supersedes: null,
      anchors: [],
      similar: [],
      replaces: null,
    },
  ],
  flagged: [
    {
      id: "flaggedShared",
      text: "Billing runs on Fridays",
      kind: "convention",
      scope: "global",
      locus: [],
      origin: "authored",
      status: "active",
      status_note: null,
      author_user_id: "jon",
      recorded_at: "<recorded_at>",
      metadata: { correction: { at: "2026-11-02T00:00:00Z", text: "not true", episode_id: "e1", candidate_id: null } },
      correction: { at: "2026-11-02T00:00:00Z", text: "not true", episode_id: "e1", candidate_id: null },
      replacing: null,
    },
  ],
};
