import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact } from "../src/facts.js";
import type { EmbedWorker } from "../src/jobs/embed.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });
const get = (token: string, url: string) => app.inject({ url, headers: auth(token) });

async function remember(token: string, body: Record<string, unknown>) {
  const res = await post(token, "/v1/facts", { kind: "decision", scope: "global", ...body });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().fact as { id: string; status: string };
}
async function list(qs: string) {
  const res = await get(curator.token, `/v1/facts?${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { facts: { id: string; origin: string }[]; has_more: boolean };
}
async function view(id: string) {
  const res = await get(curator.token, `/v1/facts/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate reviews, anchors, facts, episodes, repos, instances cascade");
  const worker = { kick: () => {}, stop: async () => {}, lastError: () => null } as EmbedWorker;
  app = buildApp(pool, { version: "test", embedder: new FakeEmbedder(), worker });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
});

describe("GET /v1/facts", () => {
  it("filters by origin, and rejects an unknown one", async () => {
    const ids: Record<string, string> = {};
    for (const origin of ["authored", "distilled", "ingested"] as const) {
      ids[origin] = (await createFact(pool, { text: `A ${origin} fact about deploys`, kind: "decision", scope: "global", origin }, curator.instance)).fact.id;
    }
    for (const origin of ["authored", "distilled", "ingested"]) {
      const { facts } = await list(`origin=${origin}`);
      expect(facts.map((f) => [f.id, f.origin])).toEqual([[ids[origin], origin]]);
    }
    expect((await list("")).facts).toHaveLength(3);
    expect((await get(curator.token, "/v1/facts?origin=bogus")).statusCode).toBe(400);
  });

  it("says whether there is another page", async () => {
    for (const t of ["First fact here", "Second fact here", "Third fact here"]) await remember(curator.token, { text: t });
    const p1 = await list("limit=2");
    expect(p1.facts).toHaveLength(2);
    expect(p1.has_more).toBe(true);
    const p2 = await list("limit=2&offset=2");
    expect(p2.facts).toHaveLength(1);
    expect(p2.has_more).toBe(false);
    const all = await list("limit=3");
    expect(all.facts).toHaveLength(3);
    expect(all.has_more).toBe(false);
    // pages don't overlap
    expect(new Set([...p1.facts, ...p2.facts].map((f) => f.id)).size).toBe(3);
  });
});

describe("GET /v1/facts/:id", () => {
  it("returns anchors with remote_url and verify details", async () => {
    await pool.query("insert into repos (key, remote_url) values ('gh/acme/api', 'https://github.com/acme/api')");
    const f = await remember(curator.token, {
      text: "Billing retries three times",
      anchors: [
        { repo_key: "gh/acme/api", path: "billing/retry.ts", line_start: 10, quote: "retries = 3" },
        { repo_key: "gh/acme/unknown", path: "x.ts", quote: "x" },
      ],
    });
    await pool.query("update anchors set verify_note = 'moved', found_line = 14 where repo_key = 'gh/acme/api'");
    const { anchors } = await view(f.id);
    const byRepo = Object.fromEntries(anchors.map((a: { repo_key: string }) => [a.repo_key, a]));
    expect(byRepo["gh/acme/api"]).toMatchObject({
      path: "billing/retry.ts",
      remote_url: "https://github.com/acme/api",
      verify_note: "moved",
      found_line: 14,
    });
    expect(byRepo["gh/acme/unknown"]).toMatchObject({ remote_url: null, verify_note: null, found_line: null });
  });

  it("returns the review history, oldest first", async () => {
    const a = await remember(alice.token, { text: "We deploy from main only" });
    const b = await remember(alice.token, { text: "Invoices go out nightly" });
    expect((await post(curator.token, `/v1/facts/${a.id}/review`, { action: "approve", note: "lgtm" })).statusCode).toBe(200);
    expect((await post(curator.token, `/v1/facts/${b.id}/review`, { action: "fix", new_text: "Invoices go out at 2am" })).statusCode).toBe(200);
    await pool.query("insert into reviews (fact_id, reviewer_user_id, action, note, created_at) values ($1, 'jon', 'approve', 'older', now() - interval '1 day')", [b.id]);

    expect((await view(a.id)).reviews).toEqual([
      { action: "approve", note: "lgtm", new_text: null, reviewer_user_id: "jon", created_at: expect.any(String) },
    ]);
    const rb = (await view(b.id)).reviews;
    expect(rb).toMatchObject([
      { action: "approve", note: "older", new_text: null },
      { action: "fix", note: null, new_text: "Invoices go out at 2am", reviewer_user_id: "jon" },
    ]);

    const own = await remember(curator.token, { text: "Curators approve their own facts" });
    expect(own.status).toBe("active");
    expect((await view(own.id)).reviews).toMatchObject([{ action: "approve", note: "authored by curator", reviewer_user_id: "jon" }]);
  });
});
