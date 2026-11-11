import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { BRIEF_MIN_SIMILARITY, estimateTokens } from "../src/brief.js";
import { createInstance, type Instance } from "../src/auth.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { embedQuery, searchFacts, type SearchDeps } from "../src/search.js";
import { addRepo, createTeam, setMember, teamPreference } from "../src/teams.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

/**
 * Teams part 3 (bennybrau/hive#117): at equal relevance, recall, search and the brief prefer
 * personal and repository > own team > organisation > other team.
 */
let pool: pg.Pool;
let app: FastifyInstance;
let embedder: FakeEmbedder;
let deps: SearchDeps;
type Who = { instance: Instance; token: string };
let curator: Who, alice: Who, bob: Who, carol: Who, nina: Who, dave: Who;

const A = "gh/acme/proj";
const D = "gh/acme/docs";
/** Every fact for Q gets the same vector as Q (and shares no word with it), so they are equally relevant. */
const Q = "where do the sprocket widgets live";
const FILE = "src/sprocket.ts";
/** For the "clearly more relevant" case: TB2 matches Q2's words and meaning, G2 only its meaning. */
const Q2 = "zebra crossing";
const oneHot = (i: number) => Array.from({ length: 768 }, (_, j) => (j === i ? 1 : 0));

const FACTS: Record<string, { scope: string; text: string; vec?: number[]; kind?: string; locus?: string[] }> = {
  R: { scope: `repo:${A}`, text: "Proj keeps its cogs under lib", vec: oneHot(700) },
  RD: { scope: `repo:${D}`, text: "Docs keeps its cogs under pages", vec: oneHot(700) },
  TA: { scope: "team:a", text: "Group A keeps cogs in the cellar", vec: oneHot(700) },
  TB: { scope: "team:b", text: "Group B keeps cogs in the attic", vec: oneHot(700) },
  TC: { scope: "team:c", text: "Group C keeps cogs in the shed", vec: oneHot(700) },
  G: { scope: "global", text: "Everyone keeps cogs somewhere sensible", vec: oneHot(700) },
  TB2: { scope: "team:b", text: "Zebra paint is chosen by group B", vec: oneHot(701) },
  G2: { scope: "global", text: "Pedestrian stripes are white", vec: oneHot(701) },
  // gotchas on FILE: gB_new is the newest, the other four share one recorded_at
  gB_new: { scope: "team:b", kind: "gotcha", locus: [FILE], text: "Group B broke the flange last week" },
  gR: { scope: `repo:${A}`, kind: "gotcha", locus: [FILE], text: "Proj flange breaks when cold" },
  gA: { scope: "team:a", kind: "gotcha", locus: [FILE], text: "Group A flange breaks when wet" },
  gG: { scope: "global", kind: "gotcha", locus: [FILE], text: "Flanges break when dropped" },
  gB: { scope: "team:b", kind: "gotcha", locus: [FILE], text: "Group B flange breaks when shaken" },
};
const ids: Record<string, string> = {};
const labelOf = (id: string) => Object.keys(ids).find((k) => ids[k] === id) ?? id;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function json(who: Who, method: "GET" | "POST", url: string, payload?: object) {
  const res = await app.inject({ method, url, headers: auth(who.token), ...(payload ? { payload } : {}) });
  expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
  return res.json();
}
const labels = (facts: { id: string }[]) => facts.map((f) => labelOf(f.id));

/** The labels as groups of equal preference: each group's labels in any order, the groups in this order. */
function expectGroups(got: string[], groups: string[][], what: string) {
  expect(got.length, `${what}: ${got.join(" ")}`).toBe(groups.flat().length);
  let i = 0;
  for (const g of groups) {
    expect(got.slice(i, i + g.length).sort(), `${what}: ${got.join(" ")}`).toEqual([...g].sort());
    i += g.length;
  }
}

/** Facts for Q from recall, search and the brief, for repoKey. */
async function reads(who: Who, repoKey: string) {
  const r = encodeURIComponent(repoKey);
  const q = encodeURIComponent(Q);
  return {
    recall: labels((await json(who, "GET", `/v1/recall?q=${q}&repo_key=${r}`)).facts),
    search: labels((await json(who, "GET", `/v1/search?q=${q}&repo_key=${r}&source=fact`)).facts),
    brief: labels((await json(who, "POST", "/v1/brief", { task: Q, repo_key: repoKey })).facts),
  };
}

/** Facts outside team scopes; the rest are recorded once the teams exist. */
const NO_TEAM = ["R", "RD", "G", "G2", "gR", "gG"];
async function record(keys: string[]) {
  for (const key of keys) {
    const f = FACTS[key]!;
    const res = await json(curator, "POST", "/v1/facts", { kind: f.kind ?? "convention", scope: f.scope, text: f.text, locus: f.locus });
    expect(res.fact.status).toBe("active");
    ids[key] = res.fact.id;
  }
}

beforeAll(async () => {
  pool = await freshDb();
  embedder = new FakeEmbedder();
  embedder.fixed.set(Q, oneHot(700)).set(Q2, oneHot(701));
  for (const f of Object.values(FACTS)) if (f.vec) embedder.fixed.set(f.text, f.vec);
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5 });
  deps = { pool, embedder, minSimilarity: 0.5 };
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
  carol = await createInstance(pool, { name: "carol-laptop", userId: "carol" });
  nina = await createInstance(pool, { name: "nina-laptop", userId: "nina" });
  dave = await createInstance(pool, { name: "dave-laptop", userId: "dave" });
  await pool.query("insert into repos (key) values ($1), ($2)", [A, D]);
  await record(NO_TEAM);
  await runEmbedPass(pool, embedder);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("migration 0017 applied, no teams yet", () => {
  it("there is no team preference", async () => {
    expect((await pool.query("select count(*)::int as n from teams")).rows[0].n).toBe(0);
    expect(await teamPreference(pool, alice.instance, A)).toBeUndefined();
    expect(await teamPreference(pool, nina.instance)).toBeUndefined();
  });

  it("recall ranks and scores exactly as before teams", async () => {
    const qvec = await embedQuery(embedder, Q);
    const before = await searchFacts(deps, alice.instance, {
      q: Q, repoKeys: [A], k: 10, statuses: ["active"], qvec, minSimilarity: 0.5, ownTeamKeys: undefined,
    });
    const recall = await json(alice, "GET", `/v1/recall?q=${encodeURIComponent(Q)}&repo_key=${encodeURIComponent(A)}`);
    expect(recall.facts.map((f: { id: string; score: number }) => [f.id, f.score])).toEqual(before.map((f) => [f.id, f.score]));
    expect(labels(recall.facts)).toEqual(expect.arrayContaining(["G", "R"]));
  });

  it("the brief ranks its facts exactly as before teams", async () => {
    const qvec = await embedQuery(embedder, Q);
    // FACTS_K in brief.ts
    const before = await searchFacts(deps, alice.instance, {
      q: Q, repoKeys: [A], k: 5, statuses: ["active"], qvec, minSimilarity: BRIEF_MIN_SIMILARITY, changedPaths: [], ownTeamKeys: undefined,
    });
    const brief = await json(alice, "POST", "/v1/brief", { task: Q, repo_key: A });
    expect(brief.facts.map((f: { id: string }) => f.id)).toEqual(before.map((f) => f.id));
    expect(labels(brief.facts)).toEqual(expect.arrayContaining(["G", "R"]));
  });
});

describe("with teams", () => {
  beforeAll(async () => {
    for (const k of ["a", "b", "c"]) await createTeam(pool, k, `Team ${k.toUpperCase()}`);
    await setMember(pool, "a", "alice", "member");
    await setMember(pool, "b", "bob", "member");
    await setMember(pool, "a", "carol", "member");
    await setMember(pool, "b", "carol", "member");
    await addRepo(pool, "c", D); // dave is in no team, but team c works on D
    await record(Object.keys(FACTS).filter((k) => !NO_TEAM.includes(k)));
    await pool.query("update facts set recorded_at = now() - interval '1 day' where id = any($1)", [[ids.gR, ids.gA, ids.gG, ids.gB]]);
    await runEmbedPass(pool, embedder);
  });

  describe("order of preference at equal relevance", () => {
    it("a team member: repository > own team > organisation > other teams", async () => {
      for (const [what, got] of Object.entries(await reads(alice, A))) expectGroups(got, [["R"], ["TA"], ["G"], ["TB", "TC"]], `alice ${what}`);
      for (const [what, got] of Object.entries(await reads(bob, A))) expectGroups(got, [["R"], ["TB"], ["G"], ["TA", "TC"]], `bob ${what}`);
    });

    it("a member of two teams: both before organisation", async () => {
      for (const [what, got] of Object.entries(await reads(carol, A))) expectGroups(got, [["R"], ["TA", "TB"], ["G"], ["TC"]], `carol ${what}`);
    });

    it("in no team, or a curator: repository > organisation > every team", async () => {
      for (const who of [nina, curator]) {
        for (const [what, got] of Object.entries(await reads(who, A))) {
          expectGroups(got, [["R"], ["G"], ["TA", "TB", "TC"]], `${who.instance.user_id} ${what}`);
        }
      }
    });

    it("a team that lists the repo counts as own, without a membership", async () => {
      for (const [what, got] of Object.entries(await reads(dave, D))) expectGroups(got, [["RD"], ["TC"], ["G"], ["TA", "TB"]], `dave ${what}`);
    });

    it("an other team's fact that is clearly more relevant still beats an organisation fact", async () => {
      const q = encodeURIComponent(Q2);
      const recall = await json(alice, "GET", `/v1/recall?q=${q}&repo_key=${encodeURIComponent(A)}`);
      expect(labels(recall.facts)).toEqual(["TB2", "G2"]);
      expect(recall.facts[0].matched.sort()).toEqual(["keyword", "meaning"]);
      expect(recall.facts[1].matched).toEqual(["meaning"]);
      const search = await json(alice, "GET", `/v1/search?q=${q}&repo_key=${encodeURIComponent(A)}&source=fact`);
      expect(labels(search.facts)).toEqual(["TB2", "G2"]);
    });
  });

  describe("brief gotchas and budget", () => {
    const brief = (who: Who, budget_tokens?: number) =>
      json(who, "POST", "/v1/brief", { task: Q, repo_key: A, changed_paths: [FILE], ...(budget_tokens ? { budget_tokens } : {}) });

    it("gotchas are newest first; the order of preference only breaks a tie", async () => {
      expect(labels((await brief(alice)).gotchas)).toEqual(["gB_new", "gR", "gA", "gG", "gB"]);
      expect(labels((await brief(bob)).gotchas)).toEqual(["gB_new", "gR", "gB", "gG", "gA"]);
      expect(labels((await brief(nina)).gotchas)).toEqual(["gB_new", "gR", "gG", "gA", "gB"]);
    });

    it("with a tight budget, other teams' gotchas and facts are dropped first", async () => {
      const full = await brief(alice, 4000);
      expect(full.dropped).toMatchObject({ gotchas: 0, facts: 0 });
      // what each item cost when packed: before the level labels were added
      const unlabelled = ({ level: _l, team: _t, team_name: _n, own_team: _o, ...f }: Record<string, unknown>) => f;
      const other = [...full.gotchas, ...full.facts].filter((f: { level: string; own_team?: boolean }) => f.level === "team" && !f.own_team);
      expect(labels(other).sort()).toEqual(["TB", "TC", "gB", "gB_new"]);
      const budget = full.tokens.total - other.reduce((n: number, f: Record<string, unknown>) => n + estimateTokens(unlabelled(f)), 0);

      const tight = await brief(alice, budget);
      expect(labels(tight.gotchas)).toEqual(["gR", "gA", "gG"]);
      expect(labels(tight.facts)).toEqual(["R", "TA", "G"]);
      expect(tight.dropped).toMatchObject({ gotchas: 2, facts: 2 });
      expect(tight.tokens.total).toBe(budget);
      expect(tight.tokens.gotchas + tight.tokens.facts).toBe(budget);
    });
  });
});
