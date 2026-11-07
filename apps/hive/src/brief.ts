/**
 * A task brief: before an agent starts on a task, the few things worth knowing — gotchas on the
 * files it will touch, relevant facts, where to look, and which tests cover it — packed into a
 * token budget. Pure SQL plus one local query embedding; no LLM.
 */
import type { Instance } from "./auth.js";
import { FACT_COLUMNS, type Fact } from "./facts.js";
import { readableScopes } from "./scope.js";
import { embedQuery, overlaps, searchDocs, searchFacts, type SearchDeps } from "./search.js";

/** Same strict gate the plugin's prefetch uses: a brief is injected, so only close facts. */
export const BRIEF_MIN_SIMILARITY = 0.62;
const FACTS_K = 5;
const LOCATIONS_K = 8;
const TESTS_K = 5;

export const SECTIONS = ["gotchas", "facts", "locations", "tests"] as const;
type Section = (typeof SECTIONS)[number];

export interface BriefFact {
  id: string;
  text: string;
  kind: Fact["kind"];
  scope: string;
  locus: string[];
  verify?: string | null;
  near_changes?: boolean;
}
export interface BriefLocation {
  /** `path:start-end` for a document passage, else the path. */
  ref: string;
  path: string;
  source: "doc" | "path";
}
export interface BriefTest {
  path: string;
  /** The location it was found next to. */
  near: string;
  /** name = its file name contains the location's; folder = same folder or below; sibling = a folder next to it. */
  why: "name" | "folder" | "sibling";
}

export interface Brief {
  repo_key: string;
  repo_indexed: boolean;
  mode: "hybrid" | "keyword";
  terms: string[];
  budget_tokens: number;
  tokens: Record<Section | "total", number>;
  dropped: Record<Section, number>;
  gotchas: BriefFact[];
  facts: BriefFact[];
  locations: BriefLocation[];
  tests: BriefTest[];
}

/** Rough token estimate of an item as sent: chars / 4. */
export const estimateTokens = (item: unknown) => Math.ceil(JSON.stringify(item).length / 4);

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const stemOf = (p: string) => {
  const b = baseOf(p);
  return b.includes(".") ? b.slice(0, b.lastIndexOf(".")) : b;
};
const within = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

/** Lexemes of the task, as Postgres' english config sees it (stopwords dropped, stemmed), 3+ chars. */
async function taskTerms(deps: SearchDeps, task: string): Promise<string[]> {
  const { rows } = await deps.pool.query<{ lexeme: string }>(
    "select lexeme from unnest(to_tsvector('english', $1)) where length(lexeme) >= 3 order by lexeme",
    [task],
  );
  return rows.map((r) => r.lexeme);
}

/** Tracked paths containing the most terms; a term in the file name counts double. */
async function pathHits(deps: SearchDeps, repoKey: string, terms: string[]): Promise<string[]> {
  if (!terms.length) return [];
  const { rows } = await deps.pool.query<{ path: string }>(
    `select path from (
       select path, (select sum(case when strpos(lower(regexp_replace(path, '^.*/', '')), t) > 0 then 2
                                     when strpos(lower(path), t) > 0 then 1 else 0 end)
                     from unnest($2::text[]) t) as score
       from repo_files where repo_key = $1) x
     where score > 0 order by score desc, length(path), path limit ${LOCATIONS_K}`,
    [repoKey, terms],
  );
  return rows.map((r) => r.path);
}

/**
 * Test files next to the locations, best first: 1) the file name contains a location's name (minus
 * extension), 2) in the location's folder or below it, 3) in a folder next to it. Earlier locations win ties.
 */
export function nearbyTests(testPaths: string[], locations: string[], k = TESTS_K): BriefTest[] {
  const isLocation = new Set(locations);
  const best = new Map<string, { rank: number; loc: number; near: string }>();
  const RANKS = ["name", "folder", "sibling"] as const;
  for (const t of testPaths) {
    if (isLocation.has(t)) continue;
    const tBase = baseOf(t).toLowerCase();
    const tDir = dirOf(t);
    locations.forEach((l, li) => {
      const stem = stemOf(l).toLowerCase();
      const dir = dirOf(l);
      const parent = dirOf(dir);
      let rank = 0;
      if (stem.length >= 3 && tBase.includes(stem)) rank = 1;
      else if (dir ? within(tDir, dir) : tDir === "") rank = 2;
      else if (dir && (parent ? within(tDir, parent) : tDir !== "")) rank = 3;
      if (!rank) return;
      const prev = best.get(t);
      if (!prev || rank < prev.rank || (rank === prev.rank && li < prev.loc)) best.set(t, { rank, loc: li, near: l });
    });
  }
  return [...best.entries()]
    .sort(([a, x], [b, y]) => x.rank - y.rank || x.loc - y.loc || a.length - b.length || a.localeCompare(b))
    .slice(0, k)
    .map(([path, v]) => ({ path, near: v.near, why: RANKS[v.rank - 1]! }));
}

/** Active gotchas the caller can read whose locus or anchor paths overlap the given paths. */
async function overlappingGotchas(deps: SearchDeps, who: Instance, repoKey: string, paths: string[]): Promise<BriefFact[]> {
  if (!paths.length) return [];
  const [scopeSql, scopeParams] = readableScopes(who, repoKey, 1, "f.scope");
  const { rows } = await deps.pool.query<Fact & { paths: string[] }>(
    `select ${FACT_COLUMNS.split(", ").map((c) => "f." + c).join(", ")},
            f.locus || coalesce((select array_agg(a.path) from anchors a where a.fact_id = f.id and a.path is not null), '{}') as paths
     from facts f where f.status = 'active' and f.kind = 'gotcha' and ${scopeSql}
     order by f.recorded_at desc`,
    scopeParams,
  );
  return rows.filter((r) => overlaps(r.paths, paths)).map((r) => ({ id: r.id, text: r.text, kind: r.kind, scope: r.scope, locus: r.locus }));
}

/** Round-robin across sections in priority order; an item that doesn't fit is skipped (and counted). */
export function packBudget(sections: Record<Section, unknown[]>, budget: number) {
  const out = Object.fromEntries(SECTIONS.map((s) => [s, [] as unknown[]])) as Record<Section, unknown[]>;
  const tokens = { gotchas: 0, facts: 0, locations: 0, tests: 0, total: 0 };
  const dropped = { gotchas: 0, facts: 0, locations: 0, tests: 0 };
  const longest = Math.max(...SECTIONS.map((s) => sections[s].length));
  for (let i = 0; i < longest; i++) {
    for (const s of SECTIONS) {
      const item = sections[s][i];
      if (item === undefined) continue;
      const cost = estimateTokens(item);
      if (tokens.total + cost > budget) {
        dropped[s]++;
        continue;
      }
      out[s].push(item);
      tokens[s] += cost;
      tokens.total += cost;
    }
  }
  return { out, tokens, dropped };
}

export async function buildBrief(
  deps: SearchDeps,
  who: Instance,
  opts: { task: string; repoKey: string; changedPaths: string[]; budgetTokens: number },
): Promise<Brief> {
  const { task, repoKey, budgetTokens } = opts;
  const changedPaths = opts.changedPaths.filter(Boolean);
  const qvec = await embedQuery(deps.embedder, task);
  const [terms, registered, factHits] = await Promise.all([
    taskTerms(deps, task),
    deps.pool.query("select 1 from repos where key = $1", [repoKey]).then((r) => (r.rowCount ?? 0) > 0),
    searchFacts(deps, who, {
      q: task, repoKey, k: FACTS_K, statuses: ["active"], qvec, minSimilarity: BRIEF_MIN_SIMILARITY, changedPaths,
    }),
  ]);

  let locations: BriefLocation[] = [];
  let tests: BriefTest[] = [];
  let gotchas: BriefFact[] = [];
  if (registered) {
    const [docs, paths] = await Promise.all([
      searchDocs(deps, { q: task, repoKey, k: LOCATIONS_K, qvec }),
      pathHits(deps, repoKey, terms),
    ]);
    const fromDocs: BriefLocation[] = docs.map((d) => ({
      ref: d.line_start != null && d.line_end != null ? `${d.path}:${d.line_start}-${d.line_end}` : d.path!,
      path: d.path!,
      source: "doc",
    }));
    const fromPaths: BriefLocation[] = paths.map((p) => ({ ref: p, path: p, source: "path" }));
    // alternate the two lists so both kinds make the cut; one entry per file
    const seen = new Set<string>();
    for (let i = 0; i < Math.max(fromDocs.length, fromPaths.length) && locations.length < LOCATIONS_K; i++) {
      for (const l of [fromDocs[i], fromPaths[i]]) {
        if (!l || seen.has(l.path) || locations.length >= LOCATIONS_K) continue;
        seen.add(l.path);
        locations.push(l);
      }
    }
    const locPaths = locations.map((l) => l.path);
    const [testRows, overlapping] = await Promise.all([
      deps.pool.query<{ path: string }>("select path from repo_files where repo_key = $1 and path ~* '(test|spec)'", [repoKey]),
      overlappingGotchas(deps, who, repoKey, [...locPaths, ...changedPaths]),
    ]);
    tests = nearbyTests(testRows.rows.map((r) => r.path), locPaths);
    gotchas = overlapping;
  }

  const gotchaIds = new Set(gotchas.map((g) => g.id));
  const facts: BriefFact[] = factHits
    .filter((f) => !gotchaIds.has(f.id))
    .map((f) => ({
      id: f.id, text: f.text, kind: f.kind, scope: f.scope, locus: f.locus, verify: f.verify,
      ...(f.near_changes !== undefined ? { near_changes: f.near_changes } : {}),
    }));

  const { out, tokens, dropped } = packBudget({ gotchas, facts, locations, tests }, budgetTokens);
  return {
    repo_key: repoKey,
    repo_indexed: registered,
    mode: qvec ? "hybrid" : "keyword",
    terms,
    budget_tokens: budgetTokens,
    tokens,
    dropped,
    gotchas: out.gotchas as BriefFact[],
    facts: out.facts as BriefFact[],
    locations: out.locations as BriefLocation[],
    tests: out.tests as BriefTest[],
  };
}
