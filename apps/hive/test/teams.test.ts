import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { ownTeams } from "../src/teams.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };

const A = "gh/acme/proj";
const B = "gh/acme/lib";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (token: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
const repoUrl = (team: string, repo: string) => `/v1/teams/${team}/repos/${encodeURIComponent(repo)}`;

beforeAll(async () => {
  pool = await freshDb();
  app = buildApp(pool, { version: "test" });
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate teams, playbooks, reviews, anchors, facts, repos, instances cascade");
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  await pool.query("insert into repos (key) values ($1), ($2)", [A, B]);
});

describe("team API", () => {
  it("creates a team, adds members and repos, lists them, and deletes it", async () => {
    const created = await call(curator.token, "POST", "/v1/teams", { key: "billing", name: "Billing" });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().team).toMatchObject({ key: "billing", name: "Billing", members: [], repos: [] });

    expect((await call(curator.token, "PUT", "/v1/teams/billing/members/alice", { role: "member" })).statusCode).toBe(200);
    expect((await call(curator.token, "PUT", "/v1/teams/billing/members/bob", { role: "reviewer" })).statusCode).toBe(200);
    // PUT again changes the role.
    const changed = await call(curator.token, "PUT", "/v1/teams/billing/members/alice", { role: "reviewer" });
    expect(changed.json().team.members).toEqual([
      { user_id: "alice", role: "reviewer" },
      { user_id: "bob", role: "reviewer" },
    ]);
    const repo = await call(curator.token, "PUT", repoUrl("billing", A));
    expect(repo.statusCode, repo.body).toBe(200);
    expect(repo.json().team.repos).toEqual([A]);
    expect((await call(curator.token, "PUT", repoUrl("billing", A))).statusCode).toBe(200);

    const list = await call(alice.token, "GET", "/v1/teams");
    expect(list.statusCode).toBe(200);
    expect(list.json().teams).toMatchObject([
      { key: "billing", name: "Billing", members: [{ user_id: "alice" }, { user_id: "bob" }], repos: [A] },
    ]);

    const removed = await call(curator.token, "DELETE", "/v1/teams/billing/members/bob");
    expect(removed.json().team.members).toEqual([{ user_id: "alice", role: "reviewer" }]);
    expect((await call(curator.token, "DELETE", repoUrl("billing", A))).json().team.repos).toEqual([]);

    const del = await call(curator.token, "DELETE", "/v1/teams/billing");
    expect(del.statusCode, del.body).toBe(200);
    expect((await call(alice.token, "GET", "/v1/teams")).json().teams).toEqual([]);
    expect((await pool.query("select * from team_members")).rows).toEqual([]);
  });

  it("refuses a bad key and a duplicate", async () => {
    for (const key of ["Billing", "bil ling", "bil_ling", "", "x".repeat(65)]) {
      const res = await call(curator.token, "POST", "/v1/teams", { key, name: "Billing" });
      expect(res.statusCode, key).toBe(400);
    }
    expect((await call(curator.token, "POST", "/v1/teams", { key: "billing-2", name: "Billing" })).statusCode).toBe(201);
    const dup = await call(curator.token, "POST", "/v1/teams", { key: "billing-2", name: "Again" });
    expect(dup.statusCode).toBe(409);
  });

  it("lets only a curator change teams", async () => {
    await call(curator.token, "POST", "/v1/teams", { key: "billing", name: "Billing" });
    const writes: [string, string, object?][] = [
      ["POST", "/v1/teams", { key: "ops", name: "Ops" }],
      ["DELETE", "/v1/teams/billing"],
      ["PUT", "/v1/teams/billing/members/alice", { role: "member" }],
      ["DELETE", "/v1/teams/billing/members/alice"],
      ["PUT", repoUrl("billing", A)],
      ["DELETE", repoUrl("billing", A)],
    ];
    for (const [method, url, body] of writes) {
      const res = await call(alice.token, method as "POST", url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await call(alice.token, "GET", "/v1/teams")).json().teams).toMatchObject([{ key: "billing", members: [], repos: [] }]);
  });

  it("answers 404 for an unknown team, repo, member or listed repo", async () => {
    await call(curator.token, "POST", "/v1/teams", { key: "billing", name: "Billing" });
    const cases: [string, string, object?][] = [
      ["DELETE", "/v1/teams/nope"],
      ["PUT", "/v1/teams/nope/members/alice", { role: "member" }],
      ["DELETE", "/v1/teams/nope/members/alice"],
      ["PUT", repoUrl("nope", A)],
      ["DELETE", repoUrl("nope", A)],
      ["DELETE", "/v1/teams/billing/members/alice"],
      ["DELETE", repoUrl("billing", A)],
      ["PUT", repoUrl("billing", "gh/acme/unregistered")],
    ];
    for (const [method, url, body] of cases) {
      const res = await call(curator.token, method as "PUT", url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await call(curator.token, "PUT", repoUrl("billing", "gh/acme/unregistered"))).json()).toEqual({ error: "unknown repo" });
  });

  it("refuses a bad role", async () => {
    await call(curator.token, "POST", "/v1/teams", { key: "billing", name: "Billing" });
    expect((await call(curator.token, "PUT", "/v1/teams/billing/members/alice", { role: "owner" })).statusCode).toBe(400);
  });

  it("/mine lists the caller's teams and role", async () => {
    await call(curator.token, "POST", "/v1/teams", { key: "ops", name: "Ops" });
    await call(curator.token, "POST", "/v1/teams", { key: "billing", name: "Billing" });
    await call(curator.token, "POST", "/v1/teams", { key: "web", name: "Web" });
    await call(curator.token, "PUT", "/v1/teams/ops/members/alice", { role: "reviewer" });
    await call(curator.token, "PUT", "/v1/teams/billing/members/alice", { role: "member" });
    await call(curator.token, "PUT", "/v1/teams/web/members/jon", { role: "member" });
    const res = await call(alice.token, "GET", "/v1/teams/mine");
    expect(res.statusCode).toBe(200);
    expect(res.json().teams).toEqual([
      { key: "billing", name: "Billing", role: "member" },
      { key: "ops", name: "Ops", role: "reviewer" },
    ]);
  });

  it("won't delete a team while a fact or playbook is in its scope", async () => {
    await call(curator.token, "POST", "/v1/teams", { key: "billing", name: "Billing" });
    const { rows } = await pool.query<{ id: string }>(
      "insert into facts (text, kind, scope, origin, status, content_hash) values ('Invoices round half-even', 'convention', 'team:billing', 'authored', 'active', 'team-billing-1') returning id",
    );
    const res = await call(curator.token, "DELETE", "/v1/teams/billing");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("1 fact(s)");
    expect((await call(curator.token, "GET", "/v1/teams")).json().teams).toHaveLength(1);

    await pool.query("delete from facts where id = $1", [rows[0]!.id]);
    await pool.query("insert into playbooks (scope, title) values ('team:billing', 'Billing playbook')");
    const again = await call(curator.token, "DELETE", "/v1/teams/billing");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain("1 playbook(s)");

    await pool.query("delete from playbooks");
    expect((await call(curator.token, "DELETE", "/v1/teams/billing")).statusCode).toBe(200);
  });
});

describe("ownTeams", () => {
  beforeEach(async () => {
    await pool.query("insert into teams (key, name) values ('billing', 'Billing'), ('lib', 'Lib'), ('ops', 'Ops')");
    await pool.query("insert into team_members (team_key, user_id, role) values ('ops', 'alice', 'member'), ('billing', 'alice', 'reviewer')");
    await pool.query("insert into team_repos (team_key, repo_key) values ('billing', $1), ('lib', $2)", [A, B]);
  });

  it("is the member teams when no repo is given", async () => {
    expect(await ownTeams(pool, { user_id: "alice" })).toEqual(["billing", "ops"]);
    expect(await ownTeams(pool, { user_id: "nobody" })).toEqual([]);
  });

  it("adds the teams listing the repo, once each, sorted", async () => {
    expect(await ownTeams(pool, { user_id: "alice" }, B)).toEqual(["billing", "lib", "ops"]);
    expect(await ownTeams(pool, { user_id: "alice" }, A)).toEqual(["billing", "ops"]);
    expect(await ownTeams(pool, { user_id: "nobody" }, A)).toEqual(["billing"]);
    expect(await ownTeams(pool, { user_id: "nobody" }, "gh/acme/unknown")).toEqual([]);
  });
});
