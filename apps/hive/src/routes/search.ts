import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { Instance } from "../auth.js";
import { recordUse } from "../facts.js";
import { resolveAlsoRepos, ScopeError } from "../scope.js";
import { embedQuery, searchDocs, searchEpisodes, searchFacts, type FactHit, type SearchDeps, type TextHit } from "../search.js";
import { labelFor, teamPreference, type LevelLabel } from "../teams.js";

export const SOURCES = ["fact", "conversation", "history", "commit", "doc"] as const;
export type Source = (typeof SOURCES)[number];

/** "all" or a comma list of SOURCES; anything else comes back in `bad`. */
export function parseSources(raw: string): { sources: Source[]; bad: string[] } {
  const sources = raw === "all" ? [...SOURCES] : (raw.split(",").map((s) => s.trim()) as Source[]);
  return { sources, bad: sources.filter((s) => !SOURCES.includes(s)) };
}

/**
 * The repos to read: repoKey, then the registered ones of alsoRepos, plus alsoRepos that
 * aren't registered (null when alsoRepos wasn't sent). Without repoKey every repo is readable, so alsoRepos is ignored.
 */
async function repoKeysOf(deps: SearchDeps, repoKey: string | undefined, alsoRepos: string[] | undefined) {
  if (!repoKey) return { repoKeys: undefined, unknown: null };
  if (alsoRepos === undefined) return { repoKeys: [repoKey], unknown: null };
  const { known, unknown } = await resolveAlsoRepos(deps.pool, repoKey, alsoRepos);
  return { repoKeys: [repoKey, ...known], unknown };
}

export interface RecallResult {
  mode: "hybrid" | "keyword";
  unknown_repos?: string[];
  facts: (FactHit & LevelLabel)[];
}

/** /v1/recall and MCP hive_recall: active facts, counted as used. ScopeError past MAX_ALSO_REPOS. */
export async function recall(
  deps: SearchDeps,
  who: Instance,
  opts: { q: string; repoKey?: string; alsoRepos?: string[]; k: number; minSimilarity?: number; changedPaths?: string[] },
  log: FastifyBaseLogger,
): Promise<RecallResult> {
  const repos = await repoKeysOf(deps, opts.repoKey, opts.alsoRepos);
  const [qvec, ownTeamKeys] = await Promise.all([embedQuery(deps.embedder, opts.q), teamPreference(deps.pool, who, opts.repoKey)]);
  const facts = await searchFacts(deps, who, {
    q: opts.q, repoKeys: repos.repoKeys, k: opts.k, statuses: ["active"], qvec, minSimilarity: opts.minSimilarity, changedPaths: opts.changedPaths,
    ownTeamKeys,
  });
  await recordUse(deps.pool, facts.map((f) => f.id), log);
  return {
    mode: qvec ? "hybrid" : "keyword", ...(repos.unknown ? { unknown_repos: repos.unknown } : {}),
    facts: await labelFor(deps.pool, who, opts.repoKey, facts),
  };
}

export interface SearchResult extends RecallResult {
  results: TextHit[];
}

/** /v1/search and MCP hive_search: facts plus text hits from the chosen sources. ScopeError past MAX_ALSO_REPOS. */
export async function search(
  deps: SearchDeps,
  who: Instance,
  opts: { q: string; sources: Source[]; repoKey?: string; alsoRepos?: string[]; k: number; includeCandidates?: boolean },
): Promise<SearchResult> {
  const { q, sources, k } = opts;
  const repos = await repoKeysOf(deps, opts.repoKey, opts.alsoRepos);
  const { repoKeys } = repos;
  const [qvec, ownTeamKeys] = await Promise.all([embedQuery(deps.embedder, q), teamPreference(deps.pool, who, opts.repoKey)]);
  const statuses = opts.includeCandidates ? ["active", "candidate"] : ["active"];
  const [facts, conversation, history, commit, doc] = await Promise.all([
    sources.includes("fact") ? searchFacts(deps, who, { q, repoKeys, k, statuses, qvec, ownTeamKeys }) : [],
    sources.includes("conversation") ? searchEpisodes(deps, who, "conversation", { q, k, qvec }) : [],
    sources.includes("history") ? searchEpisodes(deps, who, "history", { q, k, qvec }) : [],
    sources.includes("commit") ? searchEpisodes(deps, who, "commit", { q, k, qvec, repoKeys }) : [],
    sources.includes("doc") ? searchDocs(deps, { q, repoKeys, k, qvec }) : [],
  ]);
  const text: TextHit[] = [...conversation, ...history, ...commit, ...doc].sort((a, b) => b.score - a.score).slice(0, k);
  return {
    mode: qvec ? "hybrid" : "keyword", ...(repos.unknown ? { unknown_repos: repos.unknown } : {}),
    facts: await labelFor(deps.pool, who, opts.repoKey, facts), results: text,
  };
}

/**
 * Hot path. Pure SQL plus one local query embedding (~5 ms warm); no LLM calls.
 * If the embedder is down, both endpoints answer keyword-only and say so in `mode`.
 */
export function searchRoutes(app: FastifyInstance, deps: SearchDeps): void {
  app.get<{ Querystring: { q: string; repo_key?: string; also_repos?: string; k?: number; min_sim?: number; changed?: string } }>(
    "/v1/recall",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 2000 },
            repo_key: { type: "string" },
            // comma list of up to 3 other repos to read too; unregistered ones come back in unknown_repos
            also_repos: { type: "string", maxLength: 2000 },
            k: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            // Strict gate for prefetch: drop any hit (keyword matches included) whose cosine
            // similarity to the question is below this. Un-embedded rows are kept.
            min_sim: { type: "number", minimum: 0, maximum: 1 },
            // comma-separated repo-relative paths the caller has changed (git status); facts whose
            // locus or anchors are there rank higher
            changed: { type: "string", maxLength: 20000 },
          },
        },
      },
    },
    async (req, reply) => {
      const { q, repo_key, also_repos, k, min_sim, changed } = req.query;
      const changedPaths = changed ? changed.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200) : undefined;
      try {
        return await recall(deps, req.instance!, {
          q, repoKey: repo_key, alsoRepos: also_repos?.split(","), k: k ?? 10, minSimilarity: min_sim, changedPaths,
        }, req.log);
      } catch (err) {
        if (err instanceof ScopeError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get<{ Querystring: { q: string; source?: string; repo_key?: string; also_repos?: string; k?: number; include_candidates?: boolean } }>(
    "/v1/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 2000 },
            source: { type: "string", default: "all" }, // all | comma list of fact,conversation,history,commit,doc
            repo_key: { type: "string" },
            also_repos: { type: "string", maxLength: 2000 }, // comma list, as for /v1/recall
            k: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            include_candidates: { type: "boolean", default: false },
          },
        },
      },
    },
    async (req, reply) => {
      const { q, repo_key, also_repos, include_candidates } = req.query;
      const { sources, bad } = parseSources(req.query.source ?? "all");
      if (bad.length) return reply.code(400).send({ error: `unknown source ${bad.join(",")}`, valid: ["all", ...SOURCES] });
      try {
        return await search(deps, req.instance!, {
          q, sources, repoKey: repo_key, alsoRepos: also_repos?.split(","), k: req.query.k ?? 20, includeCandidates: include_candidates,
        });
      } catch (err) {
        if (err instanceof ScopeError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );
}
