import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { addRepo, createTeam, setMember } from "../src/teams.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

/**
 * Teams part 2 (bennybrau/hive#117): writing into team:<key> scope, reading every team's facts, and the level labels.
 * A team fact is active only when a curator writes it; a member's or a team reviewer's is a candidate.
 */
let pool: pg.Pool;
let app: FastifyInstance;
let embedder: FakeEmbedder;
type Who = { instance: Instance; token: string };
let curator: Who, alice: Who, rita: Who, bob: Who, carol: Who, dave: Who;

const A = "gh/acme/proj";
const Q = encodeURIComponent("invoice rounding billing");
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (who: Who, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth(who.token), ...(payload ? { payload } : {}) });
async function json(who: Who, method: "GET" | "POST", url: string, payload?: object) {
  const res = await call(who, method, url, payload);
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json();
}
const remember = (who: Who, body: object) => call(who, "POST", "/v1/facts", { kind: "convention", ...body });

/** Ids of the facts written in beforeAll. */
const ids: Record<string, string> = {};

beforeAll(async () => {
  pool = await freshDb();
  embedder = new FakeEmbedder();
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5 });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  rita = await createInstance(pool, { name: "rita-laptop", userId: "rita" });
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
  carol = await createInstance(pool, { name: "carol-laptop", userId: "carol" });
  dave = await createInstance(pool, { name: "dave-laptop", userId: "dave" });
  await pool.query("insert into repos (key) values ($1)", [A]);
  await createTeam(pool, "a", "Team A");
  await createTeam(pool, "b", "Team B");
  await createTeam(pool, "c", "Team C");
  await createTeam(pool, "empty", "Nobody's facts");
  await setMember(pool, "a", "alice", "member");
  await setMember(pool, "a", "rita", "reviewer");
  await setMember(pool, "b", "bob", "member");
  await setMember(pool, "a", "carol", "member");
  await setMember(pool, "b", "carol", "member");
  await addRepo(pool, "c", A); // dave is in no team, but team c works on A
  await pool.query(
    "insert into webhooks (url, secret_enc, events, created_by_user_id) values ('http://127.0.0.1:9/hook', '\\x00', '{fact.recorded}', 'jon')",
  );

  const write = async (key: string, who: Who, body: object) => {
    const res = await remember(who, body);
    expect(res.statusCode, res.body).toBe(201);
    ids[key] = res.json().fact.id;
  };
  await write("team-a", curator, { scope: "team:a", text: "Invoice rounding in billing is half-even per line" });
  await write("team-a-gotcha", curator, {
    scope: "team", team: "a", kind: "gotcha", locus: ["src/billing/invoice.ts"], text: "Invoice billing rounding breaks on refunds",
  });
  await write("team-c", curator, { scope: "team:c", text: "Billing invoice rounding is checked by the money team" });
  await write("repo", curator, { scope: "repo", repo_key: A, text: "Invoice rounding lives in the billing module" });
  await write("global", curator, { scope: "global", text: "Billing invoice amounts are kept in cents" });
  await write("alice-personal", alice, { scope: "personal", text: "Alice checks invoice rounding in billing by hand" });
  await runEmbedPass(pool, embedder);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("writing into a team scope", () => {
  it("refuses an unknown team (404), a non-member (403), and an ambiguous or missing default team (400)", async () => {
    const body = { text: "Some billing note for a team" };
    expect((await remember(alice, { ...body, scope: "team:nope" })).statusCode).toBe(404);
    expect((await remember(alice, { ...body, scope: "team", team: "nope" })).statusCode).toBe(404);
    const forbidden = await remember(bob, { ...body, scope: "team:a" });
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect((await remember(bob, { ...body, scope: "team", team: "a" })).statusCode).toBe(403);
    const ambiguous = await remember(carol, { ...body, scope: "team" });
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.json().error).toMatch(/several teams \(a, b\)/);
    // dave's only link to a team is team c listing a repo: that isn't a membership
    const none = await remember(dave, { ...body, scope: "team" });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toMatch(/no team/);
    expect((await remember(alice, { ...body, scope: "team:a", team: "b" })).statusCode).toBe(400);
    expect((await remember(alice, { ...body, scope: "global", team: "a" })).statusCode).toBe(400);
    expect((await remember(alice, { ...body, scope: "team", team: "Not A Key" })).statusCode).toBe(400);
    expect((await pool.query("select 1 from facts where text = $1", [body.text])).rowCount).toBe(0);
  });

  it("a member's and a team reviewer's facts are candidates; a curator's, even outside the team, is active and self-approved", async () => {
    const mine = await remember(alice, { scope: "team", text: "Team A rounds invoices before tax" });
    expect(mine.statusCode, mine.body).toBe(201);
    expect(mine.json().fact).toMatchObject({ scope: "team:a", status: "candidate" });
    const carols = await remember(carol, { scope: "team", team: "b", text: "Team B rounds invoices after tax" });
    expect(carols.json().fact).toMatchObject({ scope: "team:b", status: "candidate" });
    const reviewers = await remember(rita, { scope: "team:a", text: "Team A reviews invoice rounding weekly" });
    expect(reviewers.json().fact).toMatchObject({ scope: "team:a", status: "candidate" });

    const detail = await json(curator, "GET", `/v1/facts/${ids["team-a"]}`);
    expect(detail.fact).toMatchObject({ scope: "team:a", status: "active", author_user_id: "jon" });
    expect(detail.reviews).toMatchObject([{ action: "approve", note: "authored by curator", reviewer_user_id: "jon" }]);
    expect((await json(curator, "GET", `/v1/facts/${mine.json().fact.id}`)).reviews).toEqual([]);

    // the curator sees team candidates in the review queue
    const queue = await json(curator, "GET", "/v1/review/queue?limit=50");
    expect(queue.candidates.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([mine.json().fact.id, reviewers.json().fact.id]));
  });

  it("a playbook can't be in a team scope", async () => {
    for (const scope of ["team", "team:a"]) {
      const res = await call(curator, "POST", "/v1/playbooks", { scope, title: "Team playbook" });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toMatch(/team scope/);
    }
  });

  it("a team fact queues a webhook delivery; a personal fact doesn't", async () => {
    const { rows } = await pool.query<{ id: string }>("select payload->>'id' as id from webhook_deliveries");
    const delivered = rows.map((r) => r.id);
    expect(delivered).toContain(ids["team-a"]);
    expect(delivered).not.toContain(ids["alice-personal"]);
  });
});

describe("reading team facts", () => {
  const teamA = { level: "team", team: "a", team_name: "Team A", own_team: false };
  const pick = (facts: { id: string }[], key: string) => facts.find((f) => f.id === ids[key]);

  it("a member of another team finds team A's facts on every read path, labelled as team A's", async () => {
    const recall = await json(bob, "GET", `/v1/recall?q=${Q}`);
    expect(pick(recall.facts, "team-a")).toMatchObject({ scope: "team:a", ...teamA });
    expect(pick((await json(bob, "GET", `/v1/recall?q=${Q}&repo_key=${encodeURIComponent(A)}`)).facts, "team-a")).toMatchObject(teamA);

    const brief = await json(bob, "POST", "/v1/brief", {
      task: "Fix the invoice rounding in billing", repo_key: A, changed_paths: ["src/billing/invoice.ts"],
    });
    expect(pick(brief.facts, "team-a")).toMatchObject(teamA);
    expect(pick(brief.gotchas, "team-a-gotcha")).toMatchObject(teamA);

    for (const source of ["fact", "conversation", "history", "commit", "doc", "all"]) {
      const search = await json(bob, "GET", `/v1/search?q=${Q}&repo_key=${encodeURIComponent(A)}&source=${source}`);
      if (source === "fact" || source === "all") expect(pick(search.facts, "team-a"), source).toMatchObject(teamA);
      else expect(search.facts, source).toEqual([]);
    }

    const list = await json(bob, "GET", "/v1/facts?limit=200");
    expect(pick(list.facts, "team-a")).toMatchObject(teamA);
    expect(pick(list.facts, "team-c")).toMatchObject({ level: "team", team: "c", own_team: false });
    expect((await json(bob, "GET", "/v1/facts?scope=team:a")).facts.length).toBeGreaterThan(0);
    expect((await json(bob, "GET", `/v1/facts/${ids["team-a"]}`)).fact).toMatchObject(teamA);
  });

  it("a member of another team finds team A's fact when also_repos names another repo", async () => {
    const Y = "gh/acme/lib";
    await pool.query("insert into repos (key) values ($1)", [Y]);

    const recall = await json(bob, "GET", `/v1/recall?q=${Q}&repo_key=${encodeURIComponent(A)}&also_repos=${encodeURIComponent(Y)}`);
    expect(recall.unknown_repos).toEqual([]);
    expect(pick(recall.facts, "team-a")).toMatchObject({ scope: "team:a", ...teamA });

    const brief = await json(bob, "POST", "/v1/brief", {
      task: "Fix the invoice rounding in billing", repo_key: A, also_repos: [Y], changed_paths: ["src/billing/invoice.ts"],
    });
    expect(brief.unknown_repos).toEqual([]);
    expect(pick(brief.facts, "team-a")).toMatchObject(teamA);
    expect(pick(brief.gotchas, "team-a-gotcha")).toMatchObject(teamA);
  });

  it("every fact carries its level; a member's own team is own_team: true", async () => {
    const list = await json(alice, "GET", "/v1/facts?limit=200");
    expect(pick(list.facts, "team-a")).toMatchObject({ ...teamA, own_team: true });
    expect(pick(list.facts, "alice-personal")).toMatchObject({ level: "personal" });
    expect(pick(list.facts, "repo")).toMatchObject({ level: "repository" });
    expect(pick(list.facts, "global")).toMatchObject({ level: "organisation" });
    expect(pick(list.facts, "repo")).not.toHaveProperty("team");
    expect(list.facts.find((f: { team?: string; level: string }) => f.team === undefined && f.level === "team")).toBeUndefined();
    expect(list.facts.every((f: { level?: string }) => ["personal", "repository", "team", "organisation"].includes(f.level!))).toBe(true);
  });

  it("a team that lists the repo counts as the caller's own for that repo", async () => {
    const withRepo = await json(dave, "GET", `/v1/recall?q=${Q}&repo_key=${encodeURIComponent(A)}`);
    expect(pick(withRepo.facts, "team-c")).toMatchObject({ level: "team", team: "c", own_team: true });
    const brief = await json(dave, "POST", "/v1/brief", { task: "Fix the invoice rounding in billing", repo_key: A });
    expect(pick(brief.facts, "team-c")).toMatchObject({ team: "c", own_team: true });
    const search = await json(dave, "GET", `/v1/search?q=${Q}&repo_key=${encodeURIComponent(A)}&source=fact`);
    expect(pick(search.facts, "team-c")).toMatchObject({ team: "c", own_team: true });
    const list = await json(dave, "GET", `/v1/facts?repo_key=${encodeURIComponent(A)}&limit=200`);
    expect(pick(list.facts, "team-c")).toMatchObject({ team: "c", own_team: true });
    // without the repo, team c is just another team
    expect(pick((await json(dave, "GET", `/v1/recall?q=${Q}`)).facts, "team-c")).toMatchObject({ team: "c", own_team: false });
  });

  it("another user's personal fact is on no read path", async () => {
    const id = ids["alice-personal"]!;
    const seen = [
      await json(bob, "GET", `/v1/recall?q=${Q}`),
      await json(bob, "GET", `/v1/recall?q=${Q}&repo_key=${encodeURIComponent(A)}`),
      await json(bob, "POST", "/v1/brief", { task: "Fix the invoice rounding in billing", repo_key: A, changed_paths: ["src/billing/invoice.ts"] }),
      await json(bob, "GET", `/v1/search?q=${Q}&source=all&include_candidates=true`),
      await json(bob, "GET", "/v1/facts?limit=200"),
      await json(bob, "GET", "/v1/facts?scope=personal:alice"),
    ];
    for (const s of seen) expect(JSON.stringify(s)).not.toContain(id);
    expect((await call(bob, "GET", `/v1/facts/${id}`)).statusCode).toBe(404);
    // but alice herself has it
    expect(pick((await json(alice, "GET", `/v1/recall?q=${Q}`)).facts, "alice-personal")).toMatchObject({ level: "personal" });
  });

  it("stats count every team's facts, a team with none too", async () => {
    const stats = await json(curator, "GET", "/v1/stats");
    expect(stats.facts.by_team).toEqual({ a: 4, b: 1, c: 1, empty: 0 });
  });
});
