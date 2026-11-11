import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact, type FactInput } from "../src/facts.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { createRepoSync, type RepoSync } from "../src/jobs/repo-sync.js";
import { repoKeyFromRemote } from "../src/repo-key.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";
import { commit, makeRepo, sh, write } from "./repo-fixtures.js";

let pool: pg.Pool;
let app: FastifyInstance;
let sync: RepoSync;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let bob: { instance: Instance; token: string };
let repo: ReturnType<typeof makeRepo>;

const A = "gh/acme/proj";
const B = "gh/acme/lib";
const C = "gh/acme/other";
const TASK = "Fix the invoice rounding in billing";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** One JSON-RPC request to /mcp, as Claude Code sends it (it accepts JSON or an SSE stream). */
function rpc(headers: Record<string, string>, method: string, params: unknown = {}) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...headers, accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await rpc(auth(token), "tools/call", { name, arguments: args });
  expect(res.statusCode, res.body).toBe(200);
  const { result } = res.json() as { result: { content: { type: string; text: string }[]; isError?: boolean } };
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError ?? false };
}
async function getJson(url: string, token = alice.token) {
  const res = await app.inject({ method: "GET", url, headers: auth(token) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const tags = (text: string) => [...text.matchAll(/\[hive:([0-9a-f]{8})\]/g)].map((m) => m[1]);
const id8s = (facts: { id: string }[]) => facts.map((f) => f.id.slice(0, 8));

async function fact(input: Partial<FactInput> & { text: string }, who?: Instance) {
  const { fact } = await createFact(pool, { kind: "convention", scope: `repo:${A}`, origin: "authored", ...input }, who ?? curator.instance);
  return fact;
}
/** Another git repo next to the first one, under the same root. */
function sibling(name: string, remote: string, files: Record<string, string>) {
  const dir = path.join(repo.root, name);
  mkdirSync(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "remote", "add", "origin", remote);
  write(dir, files);
  commit(dir, `Invoice rounding for billing in ${name}`);
  return dir;
}
async function register(dir: string, key: string) {
  const reg = await app.inject({ method: "POST", url: "/v1/repos", headers: auth(curator.token), payload: { path: dir } });
  expect(reg.statusCode, reg.body).toBe(201);
  const res = await app.inject({ method: "POST", url: "/v1/repos/ingest", headers: auth(curator.token), payload: { key } });
  expect(res.statusCode, res.body).toBe(200);
}
async function useCount(id: string) {
  const { rows } = await pool.query<{ use_count: number }>("select use_count from facts where id = $1", [id]);
  return rows[0]!.use_count;
}

let factA: { id: string };
let factC: { id: string };
let bobPersonal: { id: string };

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate playbooks, llm_calls, reviews, anchors, facts, episodes, doc_chunks, doc_files, repos, instances cascade");
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
  repo = makeRepo(
    {
      "docs/money.md": "# Money\n\nInvoice totals are rounded half-even, per line.\n",
      "src/billing/invoice.ts": "export const total = 1;\n",
      "src/billing/invoice.test.ts": "// test\n",
    },
    { remote: "git@github.com:acme/proj.git" },
  );
  write(repo.dir, { "src/billing/round.ts": "export const r = 1;\n" });
  commit(repo.dir, "Invoice rounding for billing in proj");
  const lib = sibling("lib", "git@github.com:acme/lib.git", { "docs/rounding.md": "# Rounding\n\nThe lib's invoice rounding helper for billing.\n" });
  const other = sibling("other", "git@github.com:acme/other.git", { "docs/invoice.md": "# Invoice\n\nThe other repo's invoice rounding notes for billing.\n" });
  const embedder = new FakeEmbedder();
  sync = createRepoSync(pool, { maxCommits: 500, intervalMin: 0, log: () => {} });
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5, repos: { roots: { root: repo.root, hostRoot: repo.root }, sync } });
  await register(repo.dir, A);
  await register(lib, B);
  await register(other, C);

  factA = await fact({ text: "Invoice billing totals are rounded half-even" });
  await fact({ scope: `repo:${B}`, text: "The lib rounds billing invoice amounts with bankers rounding" });
  factC = await fact({ scope: `repo:${C}`, text: "The other repo rounds billing invoice amounts up" });
  await fact({ scope: "global", text: "Billing invoice rounding is documented in money docs" });
  bobPersonal = await fact({ scope: "personal:bob", text: "Bob prefers invoice rounding billing totals down" }, bob.instance);
  await runEmbedPass(pool, embedder);
});
afterEach(async () => {
  await sync.stop();
  await app.close();
  repo.cleanup();
});

describe("the endpoint", () => {
  it("lists the five tools, with instructions to brief and recall", async () => {
    const init = await rpc(auth(alice.token), "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
    });
    expect(init.statusCode, init.body).toBe(200);
    const { instructions } = init.json().result;
    expect(instructions).toContain("hive_brief");
    expect(instructions).toContain("hive_recall");

    const res = await rpc(auth(alice.token), "tools/list");
    expect(res.statusCode, res.body).toBe(200);
    const tools = res.json().result.tools as { name: string; description: string }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["hive_brief", "hive_recall", "hive_remember", "hive_search", "hive_status"]);
    for (const name of ["hive_brief", "hive_recall", "hive_search"]) {
      expect(tools.find((t) => t.name === name)!.description).toContain("[hive:<id8>]");
    }
  });

  it("needs a valid token, and a worker token gets 403", async () => {
    expect((await rpc({}, "tools/list")).statusCode).toBe(401);
    expect((await rpc(auth("hive_not-a-real-token"), "tools/list")).statusCode).toBe(401);
    const worker = await createInstance(pool, { name: "worker", userId: "factory", role: "worker" });
    expect((await rpc(auth(worker.token), "tools/list")).statusCode).toBe(403);
  });

  it("is stateless: GET and DELETE are 405", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/mcp", headers: auth(alice.token) });
      expect(res.statusCode).toBe(405);
    }
  });
});

describe("hive_status", () => {
  it("says who is connected", async () => {
    const { text, isError } = await call(alice.token, "hive_status");
    expect(isError).toBe(false);
    expect(text).toContain("alice-laptop (user alice, member)");
    expect(text).toContain("3 repos");
  });
});

describe("hive_brief", () => {
  it("briefs a task from the remote URL, tags each fact, and counts it as used", async () => {
    expect(await useCount(factA.id)).toBe(0);
    const { text, isError } = await call(alice.token, "hive_brief", { task: TASK, remote_url: "git@github.com:acme/proj.git" });
    expect(isError).toBe(false);
    expect(text).toContain("## Hive brief for this task");
    expect(text).toContain(`[hive:${factA.id.slice(0, 8)}] Invoice billing totals are rounded half-even (repo, convention)`);
    expect(text).toContain("docs/money.md");
    expect(await useCount(factA.id)).toBe(1);
  });

  it("is an error without a repo", async () => {
    const res = await call(alice.token, "hive_brief", { task: TASK });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("remote_url");
    const bad = await call(alice.token, "hive_brief", { task: TASK, remote_url: "not a url" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("could not read a repo key");
  });

  it("notes an unregistered repo and unknown also_repos instead of failing", async () => {
    const res = await call(alice.token, "hive_brief", { task: TASK, repo_key: "gh/acme/nope", also_repos: ["gh/acme/ghost"] });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("gh/acme/nope is not a registered repo");
    expect(res.text).toContain("not registered, not read: gh/acme/ghost");
  });

  it("repo_key wins over remote_url", async () => {
    const { text } = await call(alice.token, "hive_brief", { task: TASK, repo_key: C, remote_url: "git@github.com:acme/proj.git" });
    expect(text).toContain(`[hive:${factC.id.slice(0, 8)}]`);
    expect(text).not.toContain(`[hive:${factA.id.slice(0, 8)}]`);
  });
});

describe("hive_recall", () => {
  it("returns tagged facts, counts them as used, and matches /v1/recall", async () => {
    const { text, isError } = await call(alice.token, "hive_recall", { q: "invoice rounding billing", repo_key: A });
    expect(isError).toBe(false);
    expect(tags(text)).toContain(factA.id.slice(0, 8));
    expect(await useCount(factA.id)).toBe(1);
    const v1 = await getJson(`/v1/recall?q=${encodeURIComponent("invoice rounding billing")}&repo_key=${A}&k=10`);
    expect(tags(text)).toEqual(id8s(v1.facts));
  });

  it("without a repo reads every repo", async () => {
    const { text, isError } = await call(alice.token, "hive_recall", { q: "invoice rounding billing" });
    expect(isError).toBe(false);
    expect(tags(text)).toEqual(expect.arrayContaining([factA.id.slice(0, 8), factC.id.slice(0, 8)]));
  });

  it("notes an unregistered repo, an unparseable remote_url and an unknown also_repos entry instead of failing", async () => {
    const unregistered = await call(alice.token, "hive_recall", { q: "invoice rounding billing", repo_key: "gh/acme/nope" });
    expect(unregistered.isError).toBe(false);
    expect(unregistered.text).toContain("gh/acme/nope is not a registered repo");

    const badUrl = await call(alice.token, "hive_recall", { q: "invoice rounding billing", remote_url: "not a url" });
    expect(badUrl.isError).toBe(false);
    expect(badUrl.text).toContain("could not read a repo key");

    const ghost = await call(alice.token, "hive_recall", { q: "invoice rounding billing", repo_key: A, also_repos: ["gh/acme/ghost"] });
    expect(ghost.isError).toBe(false);
    expect(ghost.text).toContain("not registered, not read: gh/acme/ghost");
  });
});

describe("hive_search", () => {
  const Q = "invoice rounding billing";

  it("with a repo, finds nothing from another repo unless it is in also_repos", async () => {
    const { text, isError } = await call(alice.token, "hive_search", { q: Q, remote_url: "https://github.com/acme/proj.git" });
    expect(isError).toBe(false);
    expect(text).toContain(`docs/money.md:`);
    expect(text).toMatch(new RegExp(`- commit [0-9a-f]{10} \\(${A}\\)`));
    expect(text).not.toContain(`(${C})`); // no doc or commit of C
    expect(tags(text)).not.toContain(factC.id.slice(0, 8));

    const wide = await call(alice.token, "hive_search", { q: Q, repo_key: A, also_repos: [C] });
    expect(wide.text).toContain(`docs/invoice.md:`);
    expect(wide.text).toMatch(new RegExp(`- commit [0-9a-f]{10} \\(${C}\\)`));
    expect(tags(wide.text)).toContain(factC.id.slice(0, 8));
  });

  it("without a repo searches every repo, and is not an error", async () => {
    const { text, isError } = await call(alice.token, "hive_search", { q: Q });
    expect(isError).toBe(false);
    expect(text).toContain(`(${A})`);
    expect(text).toContain(`(${C})`);
  });

  it("matches /v1/search", async () => {
    const { text } = await call(alice.token, "hive_search", { q: Q, repo_key: A, k: 10 });
    const v1 = await getJson(`/v1/search?q=${encodeURIComponent(Q)}&repo_key=${A}&k=10`);
    expect(tags(text)).toEqual(id8s(v1.facts));
  });

  it("rejects an unknown source", async () => {
    const res = await call(alice.token, "hive_search", { q: Q, source: "fact,bogus" });
    expect(res.isError).toBe(true);
  });

  it("notes an unregistered repo, an unparseable remote_url and an unknown also_repos entry instead of failing", async () => {
    const unregistered = await call(alice.token, "hive_search", { q: Q, repo_key: "gh/acme/nope" });
    expect(unregistered.isError).toBe(false);
    expect(unregistered.text).toContain("gh/acme/nope is not a registered repo");

    const badUrl = await call(alice.token, "hive_search", { q: Q, remote_url: "not a url" });
    expect(badUrl.isError).toBe(false);
    expect(badUrl.text).toContain("could not read a repo key");

    const ghost = await call(alice.token, "hive_search", { q: Q, repo_key: A, also_repos: ["gh/acme/ghost"] });
    expect(ghost.isError).toBe(false);
    expect(ghost.text).toContain("not registered, not read: gh/acme/ghost");
  });
});

describe("personal facts", () => {
  it("another user's personal fact never comes back through brief, recall or search", async () => {
    const bobs = bobPersonal.id.slice(0, 8);
    const own = await call(bob.token, "hive_recall", { q: "invoice rounding billing", repo_key: A });
    expect(tags(own.text)).toContain(bobs); // it would match

    const texts = [
      (await call(alice.token, "hive_brief", { task: TASK, repo_key: A })).text,
      (await call(alice.token, "hive_recall", { q: "invoice rounding billing", repo_key: A })).text,
      (await call(alice.token, "hive_recall", { q: "invoice rounding billing" })).text,
      (await call(alice.token, "hive_search", { q: "invoice rounding billing", repo_key: A })).text,
      (await call(alice.token, "hive_search", { q: "invoice rounding billing" })).text,
    ];
    for (const t of texts) expect(tags(t)).not.toContain(bobs);
  });
});

describe("hive_remember", () => {
  const status = async (id8: string) =>
    (await pool.query<{ status: string; scope: string }>("select status, scope from facts where id::text like $1", [`${id8}%`])).rows[0]!;

  it("a member's shared fact waits for review; a personal one is active at once", async () => {
    const shared = await call(alice.token, "hive_remember", {
      text: "Refunds always go through the ledger service", kind: "decision", scope: "repo", remote_url: "git@github.com:acme/proj.git",
    });
    expect(shared.isError).toBe(false);
    expect(shared.text).toContain("status candidate");
    expect(shared.text).toContain("the curator must approve it");
    expect(await status(tags(shared.text)[0]!)).toEqual({ status: "candidate", scope: `repo:${A}` });

    const mine = await call(alice.token, "hive_remember", { text: "I like terse commit messages", kind: "preference", scope: "personal" });
    expect(mine.text).toContain("status active");
    expect(await status(tags(mine.text)[0]!)).toEqual({ status: "active", scope: "personal:alice" });
  });

  it("scope=repo needs a repo", async () => {
    const res = await call(alice.token, "hive_remember", { text: "Something about this repo", kind: "decision", scope: "repo" });
    expect(res.isError).toBe(true);
  });
});

describe("team facts", () => {
  beforeEach(async () => {
    await pool.query("insert into teams (key, name) values ('a', 'Team A'), ('b', 'Team B') on conflict (key) do nothing");
    await pool.query(
      "insert into team_members (team_key, user_id, role) values ('a', 'alice', 'member'), ('b', 'bob', 'member') on conflict do nothing",
    );
  });

  it("a member writes into their team; a non-member gets an error", async () => {
    const res = await call(alice.token, "hive_remember", {
      text: "Refunds always go through the ledger service", kind: "decision", scope: "team", team: "a",
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.text).toContain("status candidate, team: a (your team)");
    const { rows } = await pool.query("select scope from facts where id::text like $1", [`${tags(res.text)[0]}%`]);
    expect(rows[0]).toEqual({ scope: "team:a" });

    const not = await call(alice.token, "hive_remember", { text: "Something about team B", kind: "decision", scope: "team", team: "b" });
    expect(not).toEqual({ text: "you are not in team b", isError: true });
    const none = await call(alice.token, "hive_remember", { text: "Something about team C", kind: "decision", scope: "team", team: "zz" });
    expect(none).toEqual({ text: 'no such team "zz"', isError: true });
  });

  it("recall labels the caller's own team and other teams", async () => {
    const ownTeam = await fact({ scope: "team:a", text: "Team A rounds billing invoice totals per line" });
    const otherTeam = await fact({ scope: "team:b", text: "Team B rounds billing invoice totals at the end" });
    await runEmbedPass(pool, new FakeEmbedder());
    const { text } = await call(alice.token, "hive_recall", { q: "billing invoice rounding", repo_key: A, k: 20 });
    expect(text).toContain(`[hive:${ownTeam.id.slice(0, 8)}] Team A rounds billing invoice totals per line (team: Team A (your team), convention)`);
    expect(text).toContain(`[hive:${otherTeam.id.slice(0, 8)}] Team B rounds billing invoice totals at the end (team: Team B (other team), convention)`);
    expect(text).toContain("Billing invoice rounding is documented in money docs (organisation, convention)");
  });
});

describe("repoKeyFromRemote", () => {
  it.each([
    // the plugin's own cases (plugins/hive/tests/test_hive_provider.py)
    ["git@github.com:bennybrau/hive.git", "gh/bennybrau/hive"],
    ["https://github.com/bennybrau/hive.git", "gh/bennybrau/hive"],
    ["https://github.com/bennybrau/hive", "gh/bennybrau/hive"],
    ["ssh://git@github.com/bennybrau/hive.git", "gh/bennybrau/hive"],
    ["https://gitlab.example.com/team/sub/repo.git", "gitlab.example.com/team/sub/repo"],
    ["", ""],
    // and more
    ["git@gitlab.com:team/sub/repo.git", "gitlab.com/team/sub/repo"],
    ["https://GitHub.com/bennybrau/hive.git", "gh/bennybrau/hive"],
    ["git@GitLab.Example.com:team/repo.git", "gitlab.example.com/team/repo"],
    ["  https://github.com/bennybrau/hive/  \n", "gh/bennybrau/hive"],
    ["not a url", ""],
  ])("%j -> %j", (url, key) => {
    expect(repoKeyFromRemote(url)).toBe(key);
  });
});
