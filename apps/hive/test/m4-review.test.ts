import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact } from "../src/facts.js";
import { runEmbedPass, type EmbedWorker } from "../src/jobs/embed.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let embedder: FakeEmbedder;
let kicks: number;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });
const get = (token: string, url: string) => app.inject({ url, headers: auth(token) });

async function remember(token: string, body: Record<string, unknown>) {
  const res = await post(token, "/v1/facts", { kind: "decision", scope: "global", ...body });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().fact as { id: string; status: string; text: string };
}
const review = (token: string, id: string, body: Record<string, unknown>) => post(token, `/v1/facts/${id}/review`, body);
async function factRow(id: string) {
  const { rows } = await pool.query(
    "select status, status_note, text, valid_to, supersedes, embedding is not null as embedded from facts where id = $1",
    [id],
  );
  return rows[0];
}
async function reviewsOf(id: string) {
  return (await pool.query("select reviewer_user_id, action, note, new_text from reviews where fact_id = $1 order by created_at", [id])).rows;
}
const queue = async (qs = "") => {
  const res = await get(curator.token, `/v1/review/queue${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().candidates as any[];
};

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, doc_chunks, instances cascade");
  embedder = new FakeEmbedder();
  kicks = 0;
  const worker = { kick: () => kicks++, stop: async () => {}, lastError: () => null } as EmbedWorker;
  app = buildApp(pool, { version: "test", embedder, worker });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
});

describe("review actions", () => {
  it("approve makes a candidate active and logs the review", async () => {
    const f = await remember(alice.token, { text: "We deploy to Cloud Run from main only" });
    expect(f.status).toBe("candidate");
    const res = await review(curator.token, f.id, { action: "approve", note: "lgtm" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().fact.status).toBe("active");
    expect(await reviewsOf(f.id)).toEqual([{ reviewer_user_id: "jon", action: "approve", note: "lgtm", new_text: null }]);
    expect(kicks).toBe(1); // only the remember; approve doesn't need re-embedding
  });

  it("reject retracts with a note, or just 'rejected'", async () => {
    const a = await remember(alice.token, { text: "Billing runs on Fridays" });
    const b = await remember(alice.token, { text: "Billing runs on Mondays" });
    expect((await review(curator.token, a.id, { action: "reject", note: "not true" })).statusCode).toBe(200);
    expect((await review(curator.token, b.id, { action: "reject" })).statusCode).toBe(200);
    expect(await factRow(a.id)).toMatchObject({ status: "retracted", status_note: "rejected: not true", valid_to: expect.any(Date) });
    expect(await factRow(b.id)).toMatchObject({ status: "retracted", status_note: "rejected" });
    expect(await reviewsOf(a.id)).toEqual([{ reviewer_user_id: "jon", action: "reject", note: "not true", new_text: null }]);
  });

  it("fix rewrites the text, clears the embedding for the worker, and activates", async () => {
    const f = await remember(alice.token, { text: "We deploy  to production on Fridays" });
    await runEmbedPass(pool, embedder);
    expect((await factRow(f.id)).embedded).toBe(true);
    kicks = 0;
    const res = await review(curator.token, f.id, { action: "fix", new_text: "  Invoices are sent by the billing service ", note: "reworded" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ fact: { status: "active", text: "Invoices are sent by the billing service" }, merged_into: null });
    expect(await factRow(f.id)).toMatchObject({ embedded: false });
    expect(kicks).toBe(1);
    expect(await reviewsOf(f.id)).toEqual([
      { reviewer_user_id: "jon", action: "fix", note: "reworded", new_text: "Invoices are sent by the billing service" },
    ]);
    // re-embedded from the new text: now close to a billing question, not a deploy one
    await runEmbedPass(pool, embedder);
    const rec = await get(curator.token, "/v1/recall?q=payments&min_sim=0.9");
    expect(rec.json().facts.map((x: { id: string }) => x.id)).toEqual([f.id]);
    // and the old text's identity is free again
    const again = await post(alice.token, "/v1/facts", { kind: "decision", scope: "global", text: "We deploy to production on Fridays" });
    expect(again.statusCode).toBe(201);
  });

  it("fix onto an existing active fact merges: anchors move, the candidate is retracted", async () => {
    const existing = await remember(curator.token, { text: "Postgres is the only database" });
    const cand = await remember(alice.token, { text: "We only use postgres", anchors: [{ path: "README.md", quote: "postgres only" }] });
    const res = await review(curator.token, cand.id, { action: "fix", new_text: "postgres is the ONLY   database" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().merged_into).toMatchObject({ id: existing.id, status: "active" });
    expect(res.json().merged_into.content_hash).toBeUndefined();
    expect(await factRow(cand.id)).toMatchObject({ status: "retracted", status_note: `merged into ${existing.id}` });
    const anchors = (await pool.query("select fact_id, quote from anchors")).rows;
    expect(anchors).toEqual([{ fact_id: existing.id, quote: "postgres only" }]);
    expect((await reviewsOf(cand.id))[0]).toMatchObject({ action: "fix", new_text: "postgres is the ONLY database" });
  });

  it("fix onto an existing candidate merges and activates it; onto a retracted fact is a 409", async () => {
    const other = await remember(alice.token, { text: "Team Atlas owns ingestion" });
    const cand = await remember(alice.token, { text: "Atlas team owns the ingest" });
    const res = await review(curator.token, cand.id, { action: "fix", new_text: "Team Atlas owns ingestion" });
    expect(res.statusCode, res.body).toBe(200);
    expect(await factRow(other.id)).toMatchObject({ status: "active" });
    expect(await reviewsOf(other.id)).toEqual([{ reviewer_user_id: "jon", action: "approve", note: `merged from ${cand.id}`, new_text: null }]);

    const dead = await remember(alice.token, { text: "Coverage must stay above 90%" });
    await review(curator.token, dead.id, { action: "reject" });
    const c2 = await remember(alice.token, { text: "Keep test coverage high" });
    const conflict = await review(curator.token, c2.id, { action: "fix", new_text: "coverage must stay above 90%" });
    expect(conflict.statusCode).toBe(409);
    expect(await factRow(c2.id)).toMatchObject({ status: "candidate", text: "Keep test coverage high" });
    expect(await reviewsOf(c2.id)).toEqual([]);
  });
});

describe("supersede", () => {
  it("a curator's replacement supersedes at once; the chain reads both ways", async () => {
    const a = await remember(curator.token, { text: "Deploys go out on Tuesdays" });
    const b = await remember(curator.token, { text: "Deploys go out on Wednesdays", supersedes: a.id });
    expect(b.status).toBe("active");
    expect(await factRow(a.id)).toMatchObject({ status: "superseded", valid_to: expect.any(Date) });
    const c = await remember(curator.token, { text: "Deploys go out on Thursdays", supersedes: b.id });

    const mid = (await get(alice.token, `/v1/facts/${b.id}`)).json();
    expect(mid.supersedes.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(mid.superseded_by.map((x: { id: string }) => x.id)).toEqual([c.id]);
    const newest = (await get(alice.token, `/v1/facts/${c.id}`)).json();
    expect(newest.supersedes.map((x: { id: string }) => x.id)).toEqual([b.id, a.id]);
    expect(newest.superseded_by).toEqual([]);
    const oldest = (await get(alice.token, `/v1/facts/${a.id}`)).json();
    expect(oldest.supersedes).toEqual([]);
    expect(oldest.superseded_by).toEqual([
      { id: b.id, text: "Deploys go out on Wednesdays", status: "superseded", recorded_at: expect.any(String) },
      { id: c.id, text: "Deploys go out on Thursdays", status: "active", recorded_at: expect.any(String) },
    ]);
  });

  it("a member's replacement supersedes only when approved (or fixed)", async () => {
    const a = await remember(curator.token, { text: "Releases are cut from main" });
    const b = await remember(alice.token, { text: "Releases are cut from release branches", supersedes: a.id });
    const late = await remember(alice.token, { text: "Releases are cut from tags", supersedes: a.id });
    expect(b.status).toBe("candidate");
    expect((await factRow(a.id)).status).toBe("active");
    await review(curator.token, b.id, { action: "approve" });
    expect(await factRow(a.id)).toMatchObject({ status: "superseded", valid_to: expect.any(Date) });

    const c = await remember(curator.token, { text: "Owners are listed in CODEOWNERS" });
    const d = await remember(alice.token, { text: "Owners are in the wiki", supersedes: c.id });
    await review(curator.token, d.id, { action: "fix", new_text: "Owners are listed in the team wiki" });
    expect((await factRow(c.id)).status).toBe("superseded");

    // a second replacement of an already-replaced fact leaves it as it is
    const before = await factRow(a.id);
    await review(curator.token, late.id, { action: "approve" });
    expect(await factRow(a.id)).toEqual(before);
    // and so does approving a replacement of a fact retracted meanwhile
    const r = await remember(curator.token, { text: "Staging resets nightly" });
    const r2 = await remember(alice.token, { text: "Staging resets weekly", supersedes: r.id });
    await post(curator.token, `/v1/facts/${r.id}/retract`, { reason: "staging is gone" });
    await review(curator.token, r2.id, { action: "approve" });
    expect(await factRow(r.id)).toMatchObject({ status: "retracted", status_note: "staging is gone" });

    const e = await remember(curator.token, { text: "Use pnpm for installs" });
    const f = await remember(alice.token, { text: "Use npm for installs", supersedes: e.id });
    await review(curator.token, f.id, { action: "reject" });
    expect((await factRow(e.id)).status).toBe("active");
  });

  it("supersedes must name an active, readable fact in the same scope; a dedupe ignores it", async () => {
    const g = await remember(curator.token, { text: "Global rule one" });
    const r = await remember(curator.token, { text: "Repo rule one", scope: "repo", repo_key: "gh/o/a" });
    const p = await remember(curator.token, { text: "Jon's own note", scope: "personal" });
    const bad = async (body: Record<string, unknown>) => {
      const res = await post(alice.token, "/v1/facts", { kind: "decision", scope: "global", ...body });
      expect(res.statusCode, res.body).toBe(400);
    };
    await bad({ text: "New rule", supersedes: "00000000-0000-0000-0000-000000000000" });
    await bad({ text: "New rule", supersedes: r.id }); // other scope
    await bad({ text: "New rule", supersedes: p.id }); // someone else's personal fact
    await bad({ text: "New rule", supersedes: "not-a-uuid" });
    const g2 = await remember(curator.token, { text: "Global rule two", supersedes: g.id });
    await bad({ text: "New rule", supersedes: g.id }); // already superseded
    expect((await pool.query("select count(*)::int as n from facts where text = 'New rule'")).rows[0].n).toBe(0);

    const dup = await post(curator.token, "/v1/facts", { kind: "decision", scope: "global", text: "global rule TWO", supersedes: r.id });
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ deduped: true, fact: { id: g2.id } });
    expect((await factRow(r.id)).status).toBe("active");
  });
});

describe("queue", () => {
  it("lists candidates oldest first with filters, anchors, episode snippets and similar facts", async () => {
    const ep = await post(alice.token, "/v1/episodes", {
      kind: "turn",
      session_id: "s1",
      content: `${"x".repeat(500)} we agreed THE INVOICE SERVICE OWNS BILLING from now on ${"y".repeat(500)}`,
    });
    const episodeId = ep.json().episode.id;
    const c1 = await remember(alice.token, {
      text: "The invoice service owns billing",
      anchors: [{ episode_id: episodeId, quote: "The Invoice Service owns billing" }, { path: "README.md", quote: "billing" }],
    });
    const c2 = await remember(alice.token, { text: "Repo deploys use the release script", scope: "repo", repo_key: "gh/o/a" });
    const c3 = await createFact(pool, { text: "Payments retry three times", kind: "gotcha", scope: "global", origin: "distilled" }, alice.instance);
    await remember(curator.token, { text: "Billing belongs to the payments team" }); // active, global, similar to c1
    await remember(curator.token, { text: "Team Atlas owns billing", scope: "repo", repo_key: "gh/o/b" }); // other repo: never a hint
    await remember(curator.token, { text: "My team owns invoices", scope: "personal" }); // personal: never a hint
    await remember(curator.token, { text: "Postgres stores invoices", scope: "repo", repo_key: "gh/o/a" }); // database concept: not similar

    // recorded order, without depending on clock resolution
    for (const [i, id] of [c1.id, c2.id, c3.fact.id].entries()) {
      await pool.query("update facts set recorded_at = now() - make_interval(mins => $2) where id = $1", [id, 10 - i]);
    }

    // not embedded yet: no hints
    let q = await queue();
    expect(q.map((c) => c.id)).toEqual([c1.id, c2.id, c3.fact.id]);
    expect(q[0].similar).toEqual([]);

    await runEmbedPass(pool, embedder);
    q = await queue();
    const first = q[0];
    expect(first.similar.map((s: { text: string }) => s.text)).toEqual(["Billing belongs to the payments team"]);
    expect(first.similar[0].similarity).toBeGreaterThanOrEqual(0.85);
    expect(first.anchors).toHaveLength(2);
    const epAnchor = first.anchors.find((a: { episode_id: string | null }) => a.episode_id);
    expect(epAnchor.verify_status).toBe("unverified");
    expect(epAnchor.episode_snippet).toHaveLength(300);
    expect(epAnchor.episode_snippet).toContain("THE INVOICE SERVICE OWNS BILLING");
    expect(first.anchors.find((a: { path: string | null }) => a.path).episode_snippet).toBeNull();
    expect(q[1].similar).toEqual([]); // repo:gh/o/a deploy fact; the only repo fact there is about databases

    expect((await queue("?scope=repo:gh/o/a")).map((c) => c.id)).toEqual([c2.id]);
    expect((await queue("?origin=distilled")).map((c) => c.id)).toEqual([c3.fact.id]);
    expect((await queue("?limit=2")).map((c) => c.id)).toEqual([c1.id, c2.id]);

    await review(curator.token, c1.id, { action: "approve" });
    expect((await queue()).map((c) => c.id)).toEqual([c2.id, c3.fact.id]);
  });

  it("an episode anchor carries the exchange its quote came from: bot said, you said", async () => {
    const anchorOn = async (content: string, quote: string) => {
      const ep = await post(alice.token, "/v1/episodes", { kind: "session", session_id: `s${Math.random()}`, content });
      const f = await remember(alice.token, { text: `Fact about ${quote}`, anchors: [{ episode_id: ep.json().episode.id, quote }] });
      return (await queue()).find((c) => c.id === f.id).anchors[0];
    };
    const session = [
      "user: set up the cache",
      "assistant: I'll add Redis for the cache.",
      "assistant -> terminal({})",
      "tool(terminal): ok",
      "user: no, we use Postgres for everything",
      "assistant: Got it, Postgres then.",
    ].join("\n");

    const a = await anchorOn(session, "we use Postgres for everything");
    expect(a.exchange).toEqual({ assistant: "I'll add Redis for the cache.", user: "no, we use Postgres for everything" });
    expect(a.episode_snippet).toContain("Postgres");
    expect(a.content).toBeUndefined();

    expect((await anchorOn(session, "set up the cache")).exchange).toEqual({ assistant: null, user: "set up the cache" });
    expect((await anchorOn(session, "I'll add Redis")).exchange).toBeNull();

    const reply = "a".repeat(400) + "b".repeat(600);
    expect((await anchorOn(`user: hi\nassistant: ${reply}\nuser: ok then, ship it`, "ship it")).exchange).toEqual({
      assistant: "b".repeat(600),
      user: "ok then, ship it",
    });

    const r = await remember(alice.token, { text: "Readme says billing", anchors: [{ path: "README.md", quote: "billing" }] });
    expect((await queue()).find((c) => c.id === r.id).anchors[0].exchange).toBeNull();
  });

  it("lists asked candidates first, then oldest", async () => {
    const old = await remember(alice.token, { text: "Payments retry three times" });
    const asked = await remember(alice.token, { text: "We deploy to Cloud Run from main only" });
    await pool.query("update facts set recorded_at = now() - interval '10 minutes' where id = $1", [old.id]);
    await pool.query(`update facts set metadata = '{"asked":true}' where id = $1`, [asked.id]);
    const q = await queue();
    expect(q.map((c) => c.id)).toEqual([asked.id, old.id]);
    expect(q[0].metadata.asked).toBe(true);
    expect(q[1].metadata.asked).toBeUndefined();
  });
});

describe("queue last_distill_at", () => {
  async function job(status: string, finishedMinsAgo: number | null) {
    const ep = await post(alice.token, "/v1/episodes", { kind: "session", session_id: `s${Math.random()}`, content: "a session" });
    expect(ep.statusCode, ep.body).toBeLessThan(300);
    await pool.query(
      `update distill_jobs set status = $2, finished_at = case when $3::int is null then null else now() - make_interval(mins => $3::int) end
       where episode_id = $1`,
      [ep.json().episode.id, status, finishedMinsAgo],
    );
  }
  const lastDistill = async () => {
    const res = await get(curator.token, "/v1/review/queue");
    expect(res.statusCode, res.body).toBe(200);
    return res.json().last_distill_at as string | null;
  };

  it("is null until a job is done, then the latest done job's finished_at", async () => {
    await job("queued", null);
    await job("failed", 1);
    expect(await lastDistill()).toBeNull();

    await job("done", 60);
    await job("done", 30);
    await job("failed", 5); // later, but not done
    await job("skipped", 2);
    const { rows } = await pool.query("select max(finished_at) as at from distill_jobs where status = 'done'");
    expect(await lastDistill()).toBe(rows[0].at.toISOString());
    expect(Date.now() - Date.parse((await lastDistill())!)).toBeGreaterThan(29 * 60_000);
  });
});

describe("access and errors", () => {
  it("members get 403, non-candidates 409, unknown ids 404, fix without text 400", async () => {
    const f = await remember(alice.token, { text: "Members cannot approve this" });
    expect((await get(alice.token, "/v1/review/queue")).statusCode).toBe(403);
    expect((await review(alice.token, f.id, { action: "approve" })).statusCode).toBe(403);
    expect((await factRow(f.id)).status).toBe("candidate");

    expect((await review(curator.token, f.id, { action: "fix" })).statusCode).toBe(400);
    expect((await review(curator.token, "00000000-0000-0000-0000-000000000000", { action: "approve" })).statusCode).toBe(404);
    expect((await review(curator.token, f.id, { action: "approve" })).statusCode).toBe(200);
    const again = await review(curator.token, f.id, { action: "reject" });
    expect(again.statusCode).toBe(409);
    expect((await factRow(f.id)).status).toBe("active");
    expect(await reviewsOf(f.id)).toHaveLength(1);
  });
});
