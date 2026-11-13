import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { STANDING_K } from "../src/brief.js";
import { createFact, type FactInput } from "../src/facts.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { createRepoSync, type RepoSync } from "../src/jobs/repo-sync.js";
import { createTeam, setMember } from "../src/teams.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";
import { makeRepo } from "./repo-fixtures.js";

let pool: pg.Pool;
let app: FastifyInstance;
let sync: RepoSync;
let embedder: FakeEmbedder;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let bob: { instance: Instance; token: string };
let repo: ReturnType<typeof makeRepo>;

const KEY = "gh/acme/proj";
const OTHER = "gh/acme/other";
const TASK = "Fix the invoice rounding in billing";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });

type Item = { id: string; standing?: true };
async function brief(token: string, body: Record<string, unknown> = {}) {
  const res = await post(token, "/v1/brief", { task: TASK, repo_key: KEY, budget_tokens: 4000, ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
/** A convention of the repo by default, active (a curator wrote it); its recorded_at `n` minutes after 2026-01-01. */
async function fact(input: Partial<FactInput> & { text: string; at?: number }, who = curator.instance) {
  const { at, ...rest } = input;
  const { fact } = await createFact(pool, { kind: "convention", scope: `repo:${KEY}`, origin: "authored", ...rest }, who);
  if (at !== undefined) await pool.query("update facts set recorded_at = '2026-01-01'::timestamptz + make_interval(mins => $2) where id = $1", [fact.id, at]);
  return fact.id;
}
const ids = (items: Item[]) => items.map((i) => i.id);
const standingIds = (items: Item[]) => items.filter((i) => i.standing).map((i) => i.id);
const useCount = async (id: string) => (await pool.query<{ use_count: number }>("select use_count from facts where id = $1", [id])).rows[0]!.use_count;
async function run(ref: string) {
  const res = await post(curator.token, "/v1/episodes", {
    kind: "asf_run", repo_key: KEY, ref, content: "Plan: fix invoice rounding in billing.",
    metadata: { merged_at: "2026-02-01T00:00:00Z", title: "Invoice rounding " + "long ".repeat(20), paths: ["src/billing/invoice.ts"] },
  });
  expect(res.statusCode, res.body).toBe(201);
}

// share no words and no concept with TASK: the similarity search never returns them
const FAR = ["Every user-visible change gets a line in CHANGELOG.md", "Commit messages follow Conventional Commits", "Never edit a merged migration file"];

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, doc_chunks, doc_files, repos, instances, teams cascade");
  embedder = new FakeEmbedder();
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  bob = await createInstance(pool, { name: "bob-laptop", userId: "bob" });
  repo = makeRepo(
    {
      "README.md": "# Proj\n\nThe factory deploys to Cloud Run.\n",
      "docs/money.md": "# Money\n\nIntro.\n\n## Rounding\n\nInvoice totals are rounded half-even, per line.\n",
      "src/billing/invoice.ts": "export const total = 1;\n",
      "src/billing/tax.ts": "export const rate = 0.2;\n",
      "src/billing/invoice.test.ts": "// test\n",
      "src/billing/helpers.spec.ts": "// spec\n",
    },
    { remote: "git@github.com:acme/proj.git" },
  );
  sync = createRepoSync(pool, { maxCommits: 500, intervalMin: 0, log: () => {} });
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5, repos: { roots: { root: repo.root, hostRoot: repo.root }, sync } });
  expect((await post(curator.token, "/v1/repos", { path: repo.dir })).statusCode).toBe(201);
  expect((await post(curator.token, "/v1/repos/ingest", { key: KEY })).statusCode).toBe(200);
});
afterEach(async () => {
  await sync.stop();
  await app.close();
  repo.cleanup();
});

describe("standing rules", () => {
  it("a repo convention far from the task is facts[0], standing", async () => {
    const rule = await fact({ text: FAR[0]! });
    const close = await fact({ kind: "decision", text: "Invoice billing totals are rounded half-even" });
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token);
    expect(b.facts[0]).toMatchObject({ id: rule, standing: true, kind: "convention", level: "repository" });
    expect(ids(b.facts)).toEqual([rule, close]);
    expect(b.facts[1].standing).toBeUndefined();
  });

  it("only active conventions of the repo, the caller's own teams and the organisation", async () => {
    await createTeam(pool, "x", "Team X");
    await createTeam(pool, "y", "Team Y");
    await setMember(pool, "x", "alice", "member");
    await pool.query("insert into repos (key) values ($1)", [OTHER]);
    const want = [
      await fact({ text: "Repo rule: " + FAR[0], at: 3 }),
      await fact({ scope: "team:x", text: "Team X rule: " + FAR[1], at: 2 }),
      await fact({ scope: "global", text: "Organisation rule: " + FAR[2], at: 1 }),
    ];
    const not = [
      await fact({ scope: `repo:${OTHER}`, text: "Other repo rule: " + FAR[0] }),
      await fact({ scope: "team:y", text: "Team Y rule: " + FAR[1] }),
      await fact({ scope: "personal:alice", text: "My rule: " + FAR[2] }, alice.instance),
      await fact({ text: "Candidate rule: " + FAR[0] }, alice.instance),
      await fact({ text: "Retracted rule: " + FAR[0] }),
      await fact({ text: "Superseded rule: " + FAR[0] }),
      // the same text in the same scope is the same fact (content_hash), so these say it as an invariant and a decision
      await fact({ kind: "invariant", text: "Invariant: " + FAR[0] }),
      await fact({ kind: "decision", text: "Decision: " + FAR[0] }),
    ];
    await pool.query("update facts set status = 'retracted' where text like 'Retracted%'");
    await pool.query("update facts set status = 'superseded' where text like 'Superseded%'");
    expect((await pool.query("select 1 from facts where text like 'Candidate%' and status = 'candidate'")).rowCount).toBe(1);
    await runEmbedPass(pool, embedder);

    for (const b of [await brief(alice.token), await brief(alice.token, { also_repos: [OTHER] })]) {
      expect(standingIds(b.facts)).toEqual(want);
      for (const id of not) expect(ids(b.facts)).not.toContain(id);
    }
    const labels = (await brief(alice.token)).facts.map((f: { level: string; team?: string }) => [f.level, f.team]);
    expect(labels).toEqual([["repository", undefined], ["team", "x"], ["organisation", undefined]]);
  });

  it(`at most ${STANDING_K}: pinned first, then newest`, async () => {
    const made = [];
    for (let i = 0; i < 7; i++) made.push(await fact({ text: `Rule ${i}: ${FAR[i % 3]}`, at: i }));
    await pool.query("update facts set pinned = true where id = $1", [made[0]]);
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token);
    expect(standingIds(b.facts)).toEqual([made[0], made[6], made[5], made[4], made[3]]);
    expect(ids(b.facts)).not.toContain(made[1]);
    expect(ids(b.facts)).not.toContain(made[2]);
  });

  it("on a tie, the repo's before a team's before the organisation's", async () => {
    await createTeam(pool, "x", "Team X");
    await setMember(pool, "x", "alice", "member");
    const g = await fact({ scope: "global", text: FAR[0]!, at: 5 });
    const t = await fact({ scope: "team:x", text: FAR[1]!, at: 5 });
    const r = await fact({ text: FAR[2]!, at: 5 });
    await runEmbedPass(pool, embedder);
    expect(standingIds((await brief(alice.token)).facts)).toEqual([r, t, g]);
  });

  it("a convention that matches the task too appears once, as a standing rule", async () => {
    const both = await fact({ text: "Invoice billing totals are rounded half-even" });
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token);
    expect(ids(b.facts)).toEqual([both]);
    expect(b.facts[0].standing).toBe(true);
  });

  it("the similarity facts keep their own 5: 5 matches plus 3 standing rules is 8", async () => {
    const rules = [];
    for (let i = 0; i < 3; i++) rules.push(await fact({ text: FAR[i]!, at: 10 - i }));
    const matches = [];
    for (let i = 0; i < 5; i++) matches.push(await fact({ kind: "decision", text: `Billing invoice rounding rule ${i}` }));
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token);
    expect(b.facts).toHaveLength(8);
    expect(ids(b.facts.slice(0, 3))).toEqual(rules);
    expect(ids(b.facts.slice(3)).sort()).toEqual([...matches].sort());

    // a standing rule the search finds first doesn't take one of the 5
    const best = await fact({ text: "Fix the invoice rounding in billing: always half-even", at: 0 });
    await runEmbedPass(pool, embedder);
    const recall = await (await app.inject({ method: "GET", url: `/v1/recall?q=${encodeURIComponent(TASK)}&repo_key=${KEY}&k=5&min_sim=0.62`, headers: auth(alice.token) })).json();
    expect(recall.facts[0].id).toBe(best);
    const again = await brief(alice.token);
    expect(ids(again.facts)).toEqual([...rules, best, ...ids(again.facts.slice(4))]);
    expect(ids(again.facts.slice(4)).sort()).toEqual([...matches].sort());
  });

  it("budget: standing rules go ahead of locations, runs and tests; the first ones that fit are kept", async () => {
    for (let i = 0; i < 3; i++) await fact({ text: FAR[i]!, at: 10 - i });
    for (let i = 0; i < 3; i++) await run(`run_${i}`);
    await runEmbedPass(pool, embedder);
    const full = await brief(alice.token);
    expect(full.locations.length && full.runs.length).toBeTruthy();
    const small = await brief(alice.token, { budget_tokens: 200 });
    expect(standingIds(small.facts)).toEqual(standingIds(full.facts));
    expect(small.dropped.facts).toBe(0);
    expect(small.tokens.total).toBeLessThanOrEqual(200);
    expect(small.dropped.locations + small.dropped.runs + small.dropped.tests).toBeGreaterThan(0);
    expect(small.tokens.total).toBe((["playbook", "gotchas", "facts", "locations", "runs", "tests"] as const).reduce((n, s) => n + small.tokens[s], 0));

    // each about 87 tokens: only the first fits in 100
    await pool.query("truncate facts cascade");
    const long = [];
    for (let i = 0; i < 5; i++) long.push(await fact({ text: `Rule ${i}: ${FAR[i % 3]} ` + "x".repeat(150), at: 10 - i }));
    const tight = await brief(alice.token, { budget_tokens: 100 });
    expect(standingIds(tight.facts)).toEqual([long[0]]);
    expect(tight.dropped.facts).toBe(4);
    expect(tight.tokens.facts).toBeGreaterThan(0);
    expect(tight.tokens.total).toBeLessThanOrEqual(100);
  });

  it("with also_repos, standing rules come out of the main repo's share", async () => {
    await pool.query("insert into repos (key) values ($1)", [OTHER]);
    for (let i = 0; i < 3; i++) await fact({ text: FAR[i]!, at: 10 - i });
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token, { budget_tokens: 300, also_repos: [OTHER] });
    expect(standingIds(b.facts)).toHaveLength(3);
    expect(b.tokens.total).toBeLessThanOrEqual(300);
    // the main share (60% of 150) fits only one long rule
    await pool.query("truncate facts cascade");
    for (let i = 0; i < 3; i++) await fact({ text: `Rule ${i}: ${FAR[i]} ` + "x".repeat(150), at: 10 - i });
    const tight = await brief(alice.token, { budget_tokens: 150, also_repos: [OTHER] });
    expect(standingIds(tight.facts)).toHaveLength(1);
    expect(tight.dropped.facts).toBe(2);
  });

  it("no conventions: the brief is exactly what it was before standing rules", async () => {
    const decision = await fact({ kind: "decision", text: "Invoice billing totals are rounded half-even" });
    const gotcha = await fact({ kind: "gotcha", text: "billing invoice code caches tax rates", locus: ["src/billing"] });
    await fact({ kind: "decision", scope: "global", text: FAR[0]! });
    await run("run_0");
    await runEmbedPass(pool, embedder);
    const name = new Map([[decision, "decision"], [gotcha, "gotcha"]]);
    const shape = (b: Record<string, unknown> & { gotchas: Item[]; facts: Item[] }) =>
      ({ ...b, gotchas: b.gotchas.map((g) => ({ ...g, id: name.get(g.id) })), facts: b.facts.map((f) => ({ ...f, id: name.get(f.id) })) });
    // captured from the code before this change, for the same fixture
    expect(shape(await brief(alice.token, { budget_tokens: 200 }))).toEqual(BEFORE_200);
    expect(shape(await brief(alice.token))).toEqual(BEFORE_4000);
  });

  it("use counts: a standing-only rule isn't counted; a similarity fact and a standing rule that matched are", async () => {
    const only = await fact({ text: FAR[0]! });
    const both = await fact({ text: "Invoice billing totals are rounded half-even" });
    const sim = await fact({ kind: "decision", text: "Billing invoice rounding happens per line" });
    await runEmbedPass(pool, embedder);
    const b = await brief(alice.token);
    expect(ids(b.facts).sort()).toEqual([only, both, sim].sort());
    expect(await useCount(only)).toBe(0);
    expect(await useCount(both)).toBe(1);
    expect(await useCount(sim)).toBe(1);
  });

  it("a team's convention is standing for its members only", async () => {
    await createTeam(pool, "x", "Team X");
    await setMember(pool, "x", "alice", "member");
    const rule = await fact({ scope: "team:x", text: FAR[0]! });
    await runEmbedPass(pool, embedder);
    expect(standingIds((await brief(alice.token)).facts)).toEqual([rule]);
    expect(ids((await brief(bob.token)).facts)).not.toContain(rule);
  });
});

const BEFORE_200 = {
  "repo_key": "gh/acme/proj",
  "repo_indexed": true,
  "mode": "hybrid",
  "terms": [
    "bill",
    "fix",
    "invoic",
    "round"
  ],
  "budget_tokens": 200,
  "tokens": {
    "playbook": 0,
    "gotchas": 40,
    "facts": 43,
    "locations": 37,
    "runs": 68,
    "tests": 0,
    "total": 188
  },
  "dropped": {
    "playbook": 0,
    "gotchas": 0,
    "facts": 0,
    "locations": 3,
    "runs": 0,
    "tests": 0
  },
  "playbook": [],
  "gotchas": [
    {
      "id": "gotcha",
      "text": "billing invoice code caches tax rates",
      "kind": "gotcha",
      "scope": "repo:gh/acme/proj",
      "locus": [
        "src/billing"
      ],
      "level": "repository"
    }
  ],
  "facts": [
    {
      "id": "decision",
      "text": "Invoice billing totals are rounded half-even",
      "kind": "decision",
      "scope": "repo:gh/acme/proj",
      "locus": [],
      "verify": null,
      "level": "repository"
    }
  ],
  "locations": [
    {
      "ref": "docs/money.md:1-7",
      "path": "docs/money.md",
      "source": "doc"
    },
    {
      "ref": "src/billing/invoice.ts",
      "path": "src/billing/invoice.ts",
      "source": "path"
    }
  ],
  "runs": [
    {
      "ref": "run_0",
      "title": "Invoice rounding long long long long long long long long long long long long long long long long long long long long ",
      "pr_url": null,
      "merged_at": "2026-02-01T00:00:00Z",
      "snippet": "Plan: <b>fix</b> <b>invoice</b> <b>rounding</b> in <b>billing</b>"
    }
  ],
  "tests": []
};
const BEFORE_4000 = {
  "repo_key": "gh/acme/proj",
  "repo_indexed": true,
  "mode": "hybrid",
  "terms": [
    "bill",
    "fix",
    "invoic",
    "round"
  ],
  "budget_tokens": 4000,
  "tokens": {
    "playbook": 0,
    "gotchas": 40,
    "facts": 43,
    "locations": 101,
    "runs": 68,
    "tests": 0,
    "total": 252
  },
  "dropped": {
    "playbook": 0,
    "gotchas": 0,
    "facts": 0,
    "locations": 0,
    "runs": 0,
    "tests": 0
  },
  "playbook": [],
  "gotchas": [
    {
      "id": "gotcha",
      "text": "billing invoice code caches tax rates",
      "kind": "gotcha",
      "scope": "repo:gh/acme/proj",
      "locus": [
        "src/billing"
      ],
      "level": "repository"
    }
  ],
  "facts": [
    {
      "id": "decision",
      "text": "Invoice billing totals are rounded half-even",
      "kind": "decision",
      "scope": "repo:gh/acme/proj",
      "locus": [],
      "verify": null,
      "level": "repository"
    }
  ],
  "locations": [
    {
      "ref": "docs/money.md:1-7",
      "path": "docs/money.md",
      "source": "doc"
    },
    {
      "ref": "src/billing/invoice.ts",
      "path": "src/billing/invoice.ts",
      "source": "path"
    },
    {
      "ref": "src/billing/invoice.test.ts",
      "path": "src/billing/invoice.test.ts",
      "source": "path"
    },
    {
      "ref": "src/billing/tax.ts",
      "path": "src/billing/tax.ts",
      "source": "path"
    },
    {
      "ref": "src/billing/helpers.spec.ts",
      "path": "src/billing/helpers.spec.ts",
      "source": "path"
    }
  ],
  "runs": [
    {
      "ref": "run_0",
      "title": "Invoice rounding long long long long long long long long long long long long long long long long long long long long ",
      "pr_url": null,
      "merged_at": "2026-02-01T00:00:00Z",
      "snippet": "Plan: <b>fix</b> <b>invoice</b> <b>rounding</b> in <b>billing</b>"
    }
  ],
  "tests": []
};
