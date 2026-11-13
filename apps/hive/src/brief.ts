/**
 * A task brief: before an agent starts on a task, the few things worth knowing — a matching playbook, gotchas on the
 * files it will touch, relevant facts, where to look, past factory runs on the same files, and which
 * tests cover it — packed into a
 * token budget. Pure SQL plus one local query embedding; no LLM.
 */
import type { Instance } from "./auth.js";
import { FACT_COLUMNS, type Fact } from "./facts.js";
import { bestPlaybook, trimPlaybook, type BriefPlaybook } from "./playbooks.js";
import { readableScopes, resolveAlsoRepos } from "./scope.js";
import { embedQuery, HEADLINE, overlaps, searchDocs, searchFacts, TSQUERY, type SearchDeps } from "./search.js";
import { labelFor, preferenceSteps, teamPreference, type LevelLabel } from "./teams.js";

/** Same strict gate the plugin's prefetch uses: a brief is injected, so only close facts. */
export const BRIEF_MIN_SIMILARITY = 0.62;
/** With also_repos, the share of the budget the main repo's items get first. */
export const BRIEF_MAIN_SHARE = 0.6;
const FACTS_K = 5;
/** Standing rules: conventions handed to every brief for the repo, whatever the task. */
export const STANDING_K = 5;
const LOCATIONS_K = 8;
const TESTS_K = 5;
const RUNS_K = 3;

export const SECTIONS = ["playbook", "gotchas", "facts", "locations", "runs", "tests"] as const;
type Section = (typeof SECTIONS)[number];

export interface BriefFact {
  id: string;
  text: string;
  kind: Fact["kind"];
  scope: string;
  locus: string[];
  verify?: string | null;
  near_changes?: boolean;
  /** A standing rule: in the brief because it is a convention of the repo, an own team or the organisation. */
  standing?: true;
}
export interface BriefLocation {
  /** `path:start-end` for a document passage, else the path. */
  ref: string;
  path: string;
  source: "doc" | "path";
  /** Which repo it is in; only when the brief was asked for also_repos. */
  repo_key?: string;
}
export interface BriefRun {
  /** The run's ref (its id in the factory). */
  ref: string;
  title: string | null;
  pr_url: string | null;
  merged_at: string;
  snippet: string;
  /** Which repo it ran on; only when the brief was asked for also_repos. */
  repo_key?: string;
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
  /** also_repos that aren't registered, so weren't read; only when also_repos was sent. */
  unknown_repos?: string[];
  mode: "hybrid" | "keyword";
  terms: string[];
  budget_tokens: number;
  tokens: Record<Section | "total", number>;
  dropped: Record<Section, number>;
  /** The best-matching playbook (0 or 1), trimmed to PLAYBOOK_MAX_TOKENS. */
  playbook: BriefPlaybook[];
  /** Labelled after packing, so the labels don't change what fits the budget. */
  gotchas: (BriefFact & LevelLabel)[];
  facts: (BriefFact & LevelLabel)[];
  locations: BriefLocation[];
  runs: BriefRun[];
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

/**
 * Active gotchas the caller can read whose locus or anchor paths overlap the given paths, newest first; with own teams
 * (teamPreference), the order of preference breaks a tie.
 */
async function overlappingGotchas(
  deps: SearchDeps, who: Instance, repoKeys: string[], paths: string[], ownTeamKeys: string[] | undefined,
): Promise<BriefFact[]> {
  if (!paths.length) return [];
  const [scopeSql, scopeParams] = readableScopes(who, repoKeys, 1, "f.scope");
  const { rows } = await deps.pool.query<Fact & { paths: string[] }>(
    `select ${FACT_COLUMNS.split(", ").map((c) => "f." + c).join(", ")},
            f.locus || coalesce((select array_agg(a.path) from anchors a where a.fact_id = f.id and a.path is not null), '{}') as paths
     from facts f where f.status = 'active' and f.kind = 'gotcha' and ${scopeSql}
     order by f.recorded_at desc`,
    scopeParams,
  );
  if (ownTeamKeys) {
    rows.sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
      || preferenceSteps(a.scope, ownTeamKeys) - preferenceSteps(b.scope, ownTeamKeys));
  }
  return rows.filter((r) => overlaps(r.paths, paths)).map((r) => ({ id: r.id, text: r.text, kind: r.kind, scope: r.scope, locus: r.locus }));
}

/**
 * Standing rules: active conventions of the repo, the caller's own teams and the organisation, whatever the task. Pinned
 * first, then newest; on a tie the repo's before a team's before the organisation's. Top STANDING_K.
 */
async function standingRules(deps: SearchDeps, repoKey: string, ownTeamKeys: string[] | undefined, changedPaths: string[]): Promise<BriefFact[]> {
  const scopes = [`repo:${repoKey}`, "global", ...(ownTeamKeys ?? []).map((k) => `team:${k}`)];
  const { rows } = await deps.pool.query<Fact & { verify: string | null; paths: string[] }>(
    `select ${FACT_COLUMNS.split(", ").map((c) => "f." + c).join(", ")},
            (select a.verify_status from anchors a where a.fact_id = f.id and a.verify_status <> 'unverified'
              order by case a.verify_status when 'missing' then 0 when 'drifted' then 1 when 'unverifiable_here' then 2 else 3 end
              limit 1) as verify,
            f.locus || coalesce((select array_agg(a.path) from anchors a where a.fact_id = f.id and a.path is not null), '{}') as paths
     from facts f where f.status = 'active' and f.kind = 'convention' and f.scope = any($1)
     order by f.pinned desc, f.recorded_at desc,
              case when f.scope like 'repo:%' then 0 when f.scope like 'team:%' then 1 else 2 end
     limit ${STANDING_K}`,
    [scopes],
  );
  return rows.map((r) => ({
    id: r.id, text: r.text, kind: r.kind, scope: r.scope, locus: r.locus, verify: r.verify,
    ...(changedPaths.length ? { near_changes: overlaps(r.paths, changedPaths) } : {}),
    standing: true as const,
  }));
}

/**
 * Merged factory runs of the repo that touched the given paths or match the task's words. Best first: most
 * of the paths touched, then a word match, then the newest merge (so a newer run on the same files wins).
 */
async function relatedRuns(deps: SearchDeps, repoKey: string, task: string, paths: string[]): Promise<BriefRun[]> {
  const { rows } = await deps.pool.query<{ id: string; paths: unknown; merged_at: string; fts: boolean }>(
    `select t.id, t.metadata->'paths' as paths, t.metadata->>'merged_at' as merged_at, t.content_tsv @@ ${TSQUERY} as fts
     from episodes t where t.kind = 'asf_run' and t.repo_key = $2 and t.metadata->>'merged_at' is not null`,
    [task, repoKey],
  );
  const ranked = rows
    .map((r) => {
      const runPaths = Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string") : [];
      const hits = paths.filter((p) => overlaps(runPaths, [p])).length;
      return { id: r.id, hits, fts: r.fts, at: Date.parse(r.merged_at) || 0 };
    })
    .filter((r) => r.hits > 0 || r.fts)
    .sort((a, b) => b.hits - a.hits || Number(b.fts) - Number(a.fts) || b.at - a.at)
    .slice(0, RUNS_K);
  if (!ranked.length) return [];
  const { rows: details } = await deps.pool.query<BriefRun & { id: string }>(
    `select t.id, t.ref, t.metadata->>'title' as title, t.metadata->>'pr_url' as pr_url,
            t.metadata->>'merged_at' as merged_at, ${HEADLINE} as snippet
     from episodes t where t.id = any($2)`,
    [task, ranked.map((r) => r.id)],
  );
  const byId = new Map(details.map(({ id, ...run }) => [id, run]));
  return ranked.map((r) => byId.get(r.id)!);
}

/** Where to look in one registered repo: doc passages and path matches, alternated, one entry per file, top LOCATIONS_K. */
async function repoLocations(deps: SearchDeps, repoKey: string, task: string, terms: string[], qvec: string | null): Promise<BriefLocation[]> {
  const [docs, paths] = await Promise.all([
    searchDocs(deps, { q: task, repoKeys: [repoKey], k: LOCATIONS_K, qvec }),
    pathHits(deps, repoKey, terms),
  ]);
  const fromDocs: BriefLocation[] = docs.map((d) => ({
    ref: d.line_start != null && d.line_end != null ? `${d.path}:${d.line_start}-${d.line_end}` : d.path!,
    path: d.path!,
    source: "doc",
  }));
  const fromPaths: BriefLocation[] = paths.map((p) => ({ ref: p, path: p, source: "path" }));
  // alternate the two lists so both kinds make the cut; one entry per file
  const locations: BriefLocation[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(fromDocs.length, fromPaths.length) && locations.length < LOCATIONS_K; i++) {
    for (const l of [fromDocs[i], fromPaths[i]]) {
      if (!l || seen.has(l.path) || locations.length >= LOCATIONS_K) continue;
      seen.add(l.path);
      locations.push(l);
    }
  }
  return locations;
}

/** Round-robin across sections in priority order; an item that doesn't fit is skipped (and counted). */
export function packBudget(sections: Record<Section, unknown[]>, budget: number) {
  const out = Object.fromEntries(SECTIONS.map((s) => [s, [] as unknown[]])) as Record<Section, unknown[]>;
  const dropped = Object.fromEntries(SECTIONS.map((s) => [s, 0])) as Record<Section, number>;
  const tokens = { ...dropped, total: 0 };
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

/**
 * Pack the main repo's items first into `share` of the budget, then what's left of them and the extra repos' items into
 * the rest. Each section keeps list order (main, then extras). A main item that missed the first pass is offered again
 * in the second, so only the second pass's misses count as dropped.
 */
export function packShared(
  main: Record<Section, unknown[]>, extra: Record<Section, unknown[]>, budget: number, share: number,
  /** The first pass's budget, when it isn't `floor(budget * share)` (standing rules already took part of the share). */
  firstBudget = Math.floor(budget * share),
) {
  const first = packBudget(main, firstBudget);
  const taken = new Set(SECTIONS.flatMap((s) => first.out[s]));
  const rest = Object.fromEntries(SECTIONS.map((s) => [s, [...main[s].filter((i) => !taken.has(i)), ...extra[s]]])) as Record<Section, unknown[]>;
  const second = packBudget(rest, budget - first.tokens.total);
  for (const s of SECTIONS) for (const i of second.out[s]) taken.add(i);
  const out = Object.fromEntries(SECTIONS.map((s) => [s, [...main[s], ...extra[s]].filter((i) => taken.has(i))])) as Record<Section, unknown[]>;
  const tokens = Object.fromEntries([...SECTIONS, "total" as const].map((s) => [s, first.tokens[s] + second.tokens[s]])) as Record<Section | "total", number>;
  return { out, tokens, dropped: second.dropped };
}

/** Standing rules are packed first, in order, while they fit `cap`; the first one that doesn't and the rest are dropped. */
export function packStanding(standing: BriefFact[], cap: number) {
  const kept: BriefFact[] = [];
  let tokens = 0;
  for (const f of standing) {
    const cost = estimateTokens(f);
    if (tokens + cost > cap) break;
    kept.push(f);
    tokens += cost;
  }
  return { kept, tokens, dropped: standing.length - kept.length };
}

export interface BriefOpts {
  task: string; repoKey: string; changedPaths: string[]; budgetTokens: number;
  /** Other repos to read too (facts, playbook, gotchas, locations, runs); ScopeError past MAX_ALSO_REPOS. */
  alsoRepos?: string[];
}

export async function buildBrief(deps: SearchDeps, who: Instance, opts: BriefOpts): Promise<Brief> {
  return (await briefWithUse(deps, who, opts)).brief;
}

/**
 * The brief, and the ids in it that count as used: its gotchas and similarity facts, and a standing rule only when the
 * similarity search found it too (else every convention would look used on every brief).
 */
export async function briefWithUse(deps: SearchDeps, who: Instance, opts: BriefOpts): Promise<{ brief: Brief; usedIds: string[] }> {
  const { task, repoKey, budgetTokens } = opts;
  const changedPaths = opts.changedPaths.filter(Boolean);
  const also = opts.alsoRepos ? await resolveAlsoRepos(deps.pool, repoKey, opts.alsoRepos) : null;
  const extra = also?.known ?? [];
  const repoKeys = [repoKey, ...extra];
  const [qvec, ownTeamKeys] = await Promise.all([embedQuery(deps.embedder, task), teamPreference(deps.pool, who, repoKey)]);
  const standing = await standingRules(deps, repoKey, ownTeamKeys, changedPaths);
  const standingIds = new Set(standing.map((f) => f.id));
  // standing rules don't take the similarity facts' slots: look as many deeper, then cut back to FACTS_K without them
  const factOpts = { q: task, k: FACTS_K + standing.length, statuses: ["active"], qvec, minSimilarity: BRIEF_MIN_SIMILARITY, changedPaths, ownTeamKeys };
  const [terms, registered, allFactHits, allMainFactHits, matched] = await Promise.all([
    taskTerms(deps, task),
    deps.pool.query("select 1 from repos where key = $1", [repoKey]).then((r) => (r.rowCount ?? 0) > 0),
    searchFacts(deps, who, { ...factOpts, repoKeys }),
    // with extra repos, the main repo's own top facts too, so the extra repos' can't push them out of the top k
    extra.length ? searchFacts(deps, who, { ...factOpts, repoKeys: [repoKey] }) : [],
    bestPlaybook(deps.pool, repoKey, task, changedPaths, extra),
  ]);
  const similar = (hits: typeof allFactHits) => hits.filter((f) => !standingIds.has(f.id)).slice(0, FACTS_K);
  const [factHits, mainFactHits] = [similar(allFactHits), similar(allMainFactHits)];
  const playbook = matched ? [trimPlaybook(matched)] : [];
  // with also_repos, say which repo each location and run is in
  const tag = <T extends object>(items: T[], key: string): T[] => (also ? items.map((i) => ({ ...i, repo_key: key })) : items);

  let locations: BriefLocation[] = [];
  let tests: BriefTest[] = [];
  let gotchas: BriefFact[] = [];
  let runs: BriefRun[] = [];
  const otherLocations: BriefLocation[] = [];
  const otherRuns: BriefRun[] = [];
  const extraLocations = await Promise.all(extra.map((k) => repoLocations(deps, k, task, terms, qvec)));
  if (registered) {
    locations = await repoLocations(deps, repoKey, task, terms, qvec);
    const locPaths = locations.map((l) => l.path);
    const [testRows, related] = await Promise.all([
      deps.pool.query<{ path: string }>("select path from repo_files where repo_key = $1 and path ~* '(test|spec)'", [repoKey]),
      relatedRuns(deps, repoKey, task, [...new Set([...locPaths, ...changedPaths])]),
    ]);
    tests = nearbyTests(testRows.rows.map((r) => r.path), locPaths);
    locations = tag(locations, repoKey);
    runs = tag(related, repoKey);
  }
  if (registered || extra.length) {
    const extraRuns = await Promise.all(extra.map((k, i) => relatedRuns(deps, k, task, extraLocations[i]!.map((l) => l.path))));
    const allPaths = [...locations, ...extraLocations.flat()].map((l) => l.path);
    gotchas = await overlappingGotchas(deps, who, repoKeys, [...allPaths, ...changedPaths], ownTeamKeys);
    extra.forEach((k, i) => {
      otherLocations.push(...tag(extraLocations[i]!, k));
      otherRuns.push(...tag(extraRuns[i]!, k));
    });
  }

  const gotchaIds = new Set(gotchas.map((g) => g.id));
  const toFacts = (hits: typeof factHits): BriefFact[] =>
    hits
      .filter((f) => !gotchaIds.has(f.id))
      .map((f) => ({
        id: f.id, text: f.text, kind: f.kind, scope: f.scope, locus: f.locus, verify: f.verify,
        ...(f.near_changes !== undefined ? { near_changes: f.near_changes } : {}),
      }));

  // other teams' gotchas and facts are held back and packed last, into what the rest leaves of the budget
  const otherTeam = (f: BriefFact) => !!ownTeamKeys && preferenceSteps(f.scope, ownTeamKeys) === 3;
  const later: Record<Section, BriefFact[]> = { playbook: [], gotchas: [], facts: [], locations: [], runs: [], tests: [] };
  const holdBack = (sections: Record<Section, unknown[]>): Record<Section, unknown[]> => {
    const keep = (s: "gotchas" | "facts") => {
      later[s].push(...(sections[s] as BriefFact[]).filter(otherTeam));
      return (sections[s] as BriefFact[]).filter((f) => !otherTeam(f));
    };
    return { ...sections, gotchas: keep("gotchas"), facts: keep("facts") };
  };

  // standing rules are packed first, into the budget (with also_repos, the main repo's share); the rest get what's left
  const st = standing.length ? packStanding(standing, extra.length ? Math.floor(budgetTokens * BRIEF_MAIN_SHARE) : budgetTokens) : null;
  const left = budgetTokens - (st?.tokens ?? 0);
  let packed: ReturnType<typeof packBudget>;
  let all: Record<Section, unknown[]>;
  if (extra.length) {
    // the main repo's items get the first BRIEF_MAIN_SHARE of the budget; extra repos' compete for the rest
    const extraScopes = new Set(extra.map((k) => `repo:${k}`));
    const mainFactIds = new Set(mainFactHits.map((f) => f.id));
    const mainPlaybook = playbook.filter((p) => p.scope === `repo:${repoKey}` || p.scope === "global");
    const main: Record<Section, unknown[]> = {
      playbook: mainPlaybook, gotchas: gotchas.filter((g) => !extraScopes.has(g.scope)), facts: toFacts(mainFactHits),
      locations, runs, tests,
    };
    const rest: Record<Section, unknown[]> = {
      playbook: playbook.filter((p) => !mainPlaybook.includes(p)), gotchas: gotchas.filter((g) => extraScopes.has(g.scope)),
      facts: toFacts(factHits.filter((f) => !mainFactIds.has(f.id))), locations: otherLocations, runs: otherRuns, tests: [],
    };
    all = Object.fromEntries(SECTIONS.map((s) => [s, [...main[s], ...rest[s]]])) as Record<Section, unknown[]>;
    packed = st
      ? packShared(holdBack(main), holdBack(rest), left, BRIEF_MAIN_SHARE, Math.floor(budgetTokens * BRIEF_MAIN_SHARE) - st.tokens)
      : packShared(holdBack(main), holdBack(rest), budgetTokens, BRIEF_MAIN_SHARE);
  } else {
    all = { playbook, gotchas, facts: toFacts(factHits), locations, runs, tests };
    packed = packBudget(holdBack(all), left);
  }
  if (st) {
    all = { ...all, facts: [...standing, ...all.facts] };
    packed = {
      out: { ...packed.out, facts: [...st.kept, ...packed.out.facts] },
      tokens: { ...packed.tokens, facts: packed.tokens.facts + st.tokens, total: packed.tokens.total + st.tokens },
      dropped: { ...packed.dropped, facts: packed.dropped.facts + st.dropped },
    };
  }
  if (later.gotchas.length || later.facts.length) {
    const last = packBudget(later, budgetTokens - packed.tokens.total);
    const taken = new Set([...SECTIONS.flatMap((s) => packed.out[s]), ...last.out.gotchas, ...last.out.facts]);
    packed = {
      out: Object.fromEntries(SECTIONS.map((s) => [s, all[s].filter((i) => taken.has(i))])) as Record<Section, unknown[]>,
      tokens: Object.fromEntries([...SECTIONS, "total" as const].map((s) => [s, packed.tokens[s] + last.tokens[s]])) as Record<Section | "total", number>,
      dropped: Object.fromEntries(SECTIONS.map((s) => [s, packed.dropped[s] + last.dropped[s]])) as Record<Section, number>,
    };
  }
  const { out, tokens, dropped } = packed;
  const labelled = await labelFor(deps.pool, who, repoKey, [...(out.gotchas as BriefFact[]), ...(out.facts as BriefFact[])]);
  // a standing rule counts as used only when it was in the similarity search's own top FACTS_K too
  const hitIds = new Set([...allFactHits.slice(0, FACTS_K), ...allMainFactHits.slice(0, FACTS_K), ...factHits, ...mainFactHits].map((f) => f.id));
  const usedIds = labelled.filter((f) => !f.standing || hitIds.has(f.id)).map((f) => f.id);
  const brief: Brief = {
    repo_key: repoKey,
    repo_indexed: registered,
    ...(also ? { unknown_repos: also.unknown } : {}),
    mode: qvec ? "hybrid" : "keyword",
    terms,
    budget_tokens: budgetTokens,
    tokens,
    dropped,
    playbook: out.playbook as BriefPlaybook[],
    gotchas: labelled.slice(0, out.gotchas.length),
    facts: labelled.slice(out.gotchas.length),
    locations: out.locations as BriefLocation[],
    runs: out.runs as BriefRun[],
    tests: out.tests as BriefTest[],
  };
  return { brief, usedIds };
}
