import type pg from "pg";
import type { Instance } from "./auth.js";
import { toPgVector, type Embedder } from "./embed.js";
import { FACT_COLUMNS, type Fact } from "./facts.js";
import { readableScopes } from "./scope.js";

export interface SearchDeps {
  pool: pg.Pool;
  embedder: Embedder | null;
  /** Cosine similarity floor for vector hits. */
  minSimilarity: number;
}

export type Mode = "hybrid" | "keyword";
export type Matched = "keyword" | "meaning";

/**
 * Keyword query: Postgres' english parser + stemmer, but OR-ed instead of AND-ed, so a natural
 * question ("who owns payments?") matches facts that contain only some of its words; ts_rank_cd
 * still ranks facts matching more of them higher. All-stopword queries match nothing.
 */
export const TSQUERY = "replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery";

const RRF_K = 60;

/** Embed the query for meaning search. Any failure -> null, and the caller runs keyword-only. */
export async function embedQuery(embedder: Embedder | null, q: string): Promise<string | null> {
  if (!embedder) return null;
  try {
    const { vectors } = await embedder.embed([q], "query", { timeoutMs: 2_000 });
    return toPgVector(vectors[0]!);
  } catch {
    return null;
  }
}

interface Ranked {
  id: string;
  score: number;
  matched: Matched[];
  similarity: number | null;
}

/**
 * Reciprocal rank fusion of a keyword list and a meaning list (each in rank order), best first.
 * Keyword hits carry their own similarity when the row is embedded, so a strict gate can judge them too.
 */
export function fuse(
  keyword: { id: string; similarity: number | null }[],
  meaning: { id: string; similarity: number }[],
): Ranked[] {
  const acc = new Map<string, Ranked>();
  keyword.forEach(({ id, similarity }, i) => {
    acc.set(id, { id, score: 1 / (RRF_K + i + 1), matched: ["keyword"], similarity });
  });
  meaning.forEach(({ id, similarity }, i) => {
    const prev = acc.get(id);
    const add = 1 / (RRF_K + i + 1);
    if (prev) {
      prev.score += add;
      prev.matched.push("meaning");
      prev.similarity = similarity;
    } else acc.set(id, { id, score: add, matched: ["meaning"], similarity });
  });
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/**
 * Strict relevance gate (used by prefetch, where every injected line is replayed on every later
 * turn): keep a hit only if the model judges it close enough. Rows with no similarity (not yet
 * embedded, or keyword-only mode) can't be judged and are kept.
 */
export function passesGate(r: Ranked, minSimilarity: number | undefined): boolean {
  if (minSimilarity === undefined || r.similarity === null) return true;
  return r.similarity >= minSimilarity;
}

interface Spec {
  table: string;
  tsv: string;
  /** WHERE fragment (without "where") and its params, numbered from $2. */
  filter: [string, unknown[]];
}

async function hybridIds(
  deps: SearchDeps,
  spec: Spec,
  q: string,
  qvec: string | null,
  k: number,
  strictSimilarity?: number,
): Promise<Ranked[]> {
  const pool = deps.pool;
  const [where, params] = spec.filter;
  const depth = Math.max(k * 3, 30); // look deeper than k so fusion has material
  const vecParam = `$${params.length + 2}`;
  const kwSim = qvec
    ? `case when t.embedding is null then null else 1 - (t.embedding <=> ${vecParam}::vector) end`
    : "null::float8";
  const kw = pool.query<{ id: string; similarity: number | null }>(
    `select t.id, ${kwSim} as similarity from ${spec.table} t
     where t.${spec.tsv} @@ ${TSQUERY} and ${where}
     order by ts_rank_cd(t.${spec.tsv}, ${TSQUERY}) desc
     limit ${depth}`,
    qvec ? [q, ...params, qvec] : [q, ...params],
  );
  const vec = qvec
    ? pool.query<{ id: string; similarity: number }>(
        `select t.id, 1 - (t.embedding <=> $1::vector) as similarity from ${spec.table} t
         where t.embedding is not null and ${where}
         order by t.embedding <=> $1::vector
         limit ${depth}`,
        [qvec, ...params],
      )
    : null;
  const [kwRows, vecRows] = await Promise.all([kw, vec]);
  const keyword = kwRows.rows.map((r) => ({ id: r.id, similarity: r.similarity === null ? null : Number(r.similarity) }));
  const meaning = (vecRows?.rows ?? [])
    .map((r) => ({ id: r.id, similarity: Number(r.similarity) }))
    .filter((r) => r.similarity >= deps.minSimilarity);
  return fuse(keyword, meaning).filter((r) => passesGate(r, strictSimilarity)).slice(0, k);
}

function byRank<T extends { id: string }>(ranked: Ranked[], rows: T[]) {
  const map = new Map(rows.map((r) => [r.id, r]));
  return ranked.flatMap((r) => {
    const row = map.get(r.id);
    return row ? [{ ...row, score: Number(r.score.toFixed(5)), matched: r.matched, similarity: r.similarity === null ? null : Number(r.similarity.toFixed(3)) }] : [];
  });
}

export interface FactHit extends Fact {
  anchors: number;
  /** Worst verify status among the fact's anchors (missing > drifted > verified), null = nothing checked. */
  verify: string | null;
  /** True when the fact's locus or anchor paths overlap the caller's changed files. */
  near_changes?: boolean;
  score: number;
  matched: Matched[];
  similarity: number | null;
}

export async function searchFacts(
  deps: SearchDeps,
  who: Instance,
  opts: {
    /** The main repo first, then any extra repos to read too; on a score tie the main repo's fact goes first. */
    q: string; repoKeys?: string[]; k: number; statuses: string[]; qvec: string | null; minSimilarity?: number;
    /** Repo-relative paths the caller is working on (git status); facts located there rank higher. */
    changedPaths?: string[];
  },
): Promise<FactHit[]> {
  const repoKeys = opts.repoKeys?.length ? opts.repoKeys : undefined;
  const [scopeSql, scopeParams] = readableScopes(who, repoKeys, 3, "t.scope");
  const filter: [string, unknown[]] = [`t.status = any($2) and ${scopeSql}`, [opts.statuses, ...scopeParams]];
  const changed = (opts.changedPaths ?? []).filter(Boolean);
  const main = repoKeys && repoKeys.length > 1 ? `repo:${repoKeys[0]}` : null;
  // with changed paths, look deeper so a located fact ranked just below k can be lifted into it
  // (and with extra repos, so a main-repo fact tied just below k wins the tie)
  const depth = changed.length || main ? opts.k * 3 : opts.k;
  const ranked = await hybridIds(deps, { table: "facts", tsv: "text_tsv", filter }, opts.q, opts.qvec, depth, opts.minSimilarity);
  if (ranked.length === 0) return [];
  const { rows } = await deps.pool.query<Fact & { anchors: number; verify: string | null; paths: string[] }>(
    `select ${FACT_COLUMNS.split(", ").map((c) => "f." + c).join(", ")},
            (select count(*)::int from anchors a where a.fact_id = f.id) as anchors,
            (select a.verify_status from anchors a where a.fact_id = f.id and a.verify_status <> 'unverified'
              order by case a.verify_status when 'missing' then 0 when 'drifted' then 1 when 'unverifiable_here' then 2 else 3 end
              limit 1) as verify,
            f.locus || coalesce((select array_agg(a.path) from anchors a where a.fact_id = f.id and a.path is not null), '{}') as paths
     from facts f where f.id = any($1)`,
    [ranked.map((r) => r.id)],
  );
  const near = new Set(rows.filter((r) => overlaps(r.paths, changed)).map((r) => r.id));
  const inMain = new Set(main ? rows.filter((r) => r.scope === main).map((r) => r.id) : []);
  if (near.size || main) {
    for (const r of ranked) if (near.has(r.id)) r.score += LOCUS_BOOST;
    ranked.sort((a, b) => b.score - a.score || Number(inMain.has(b.id)) - Number(inMain.has(a.id)));
  }
  return byRank(ranked.slice(0, opts.k), rows).map(({ paths: _paths, ...r }) => (changed.length ? { ...r, near_changes: near.has(r.id) } : r));
}

/** Same as being ranked first by one more signal in reciprocal rank fusion. */
export const LOCUS_BOOST = 1 / (RRF_K + 1);

/** A locus entry matches a changed file if it is that file or a directory containing it. */
export function overlaps(locus: string[], changed: string[]): boolean {
  const norm = (p: string) => p.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  return locus.some((l0) => {
    const l = norm(l0).replace(/\/+$/, "");
    if (!l) return false;
    return changed.some((c0) => {
      const c = norm(c0);
      return c === l || c.startsWith(l + "/");
    });
  });
}

export type EpisodeSource = "conversation" | "history" | "commit";

export interface TextHit {
  source: EpisodeSource | "doc";
  id: string;
  snippet: string;
  score: number;
  matched: Matched[];
  similarity: number | null;
  session_id?: string | null;
  repo_key?: string | null;
  path?: string;
  line_start?: number | null;
  line_end?: number | null;
  ref?: string | null;
  created_at?: string;
  /** Commit hits: the message's first line. */
  subject?: string;
  /** asf_run history hits: from the run's metadata. */
  title?: string | null;
  pr_url?: string | null;
  merged_at?: string | null;
  /** asf_dialog history hits: who wrote the note (metadata.author). */
  author?: string | null;
  /** Doc hits: the commit the chunk was read at (the repo's last ingest), for links. */
  sha?: string | null;
  remote_url?: string | null;
}

export const HEADLINE = `ts_headline('english', left(t.content, 20000), ${TSQUERY}, 'MaxFragments=2, MaxWords=30, MinWords=10, FragmentDelimiter=" … "')`;

/**
 * Conversations (turn episodes) and session history: only the caller's own user's.
 * History also holds asf_run episodes (a factory run's plan and review) and asf_dialog episodes (what a person
 * said to the factory), shared like commits: they are repo history, and every token can read every repo scope.
 * Commits: shared repo history, visible to everyone, optionally only some repos'.
 */
export async function searchEpisodes(
  deps: SearchDeps,
  who: Instance,
  source: EpisodeSource,
  opts: { q: string; k: number; qvec: string | null; repoKeys?: string[] },
): Promise<TextHit[]> {
  let filter: [string, unknown[]];
  if (source === "commit") {
    filter = opts.repoKeys?.length ? ["t.kind = 'commit' and t.repo_key = any($2)", [opts.repoKeys]] : ["t.kind = 'commit'", []];
  } else if (source === "history") {
    filter = ["((t.kind = 'session' and t.user_id = $2) or t.kind in ('asf_run','asf_dialog'))", [who.user_id]];
  } else {
    filter = ["t.kind = 'turn' and t.user_id = $2", [who.user_id]];
  }
  const ranked = await hybridIds(deps, { table: "episodes", tsv: "content_tsv", filter }, opts.q, opts.qvec, opts.k);
  if (ranked.length === 0) return [];
  const { rows } = await deps.pool.query<{
    id: string; snippet: string; session_id: string | null; repo_key: string | null; ref: string | null; created_at: string;
    subject: string; kind: string; title: string | null; pr_url: string | null; merged_at: string | null; author: string | null;
  }>(
    `select t.id, ${HEADLINE} as snippet, t.session_id, t.repo_key, t.ref, t.created_at, split_part(t.content, E'\n', 1) as subject,
            t.kind, t.metadata->>'title' as title, t.metadata->>'pr_url' as pr_url, t.metadata->>'merged_at' as merged_at,
            t.metadata->>'author' as author
     from episodes t where t.id = any($2)`,
    [opts.q, ranked.map((r) => r.id)],
  );
  return byRank(ranked, rows).map(({ subject, kind, title, pr_url, merged_at, author, ...r }) =>
    source === "commit" ? { source, ...r, subject }
    : kind === "asf_run" ? { source, ...r, title, pr_url, merged_at }
    : kind === "asf_dialog" ? { source, ...r, author }
    : { source, ...r });
}

export async function searchDocs(
  deps: SearchDeps,
  opts: { q: string; repoKeys?: string[]; k: number; qvec: string | null },
): Promise<TextHit[]> {
  const filter: [string, unknown[]] = opts.repoKeys?.length ? ["t.repo_key = any($2)", [opts.repoKeys]] : ["true", []];
  const ranked = await hybridIds(deps, { table: "doc_chunks", tsv: "content_tsv", filter }, opts.q, opts.qvec, opts.k);
  if (ranked.length === 0) return [];
  const { rows } = await deps.pool.query<{
    id: string; snippet: string; repo_key: string; path: string; line_start: number | null; line_end: number | null;
    sha: string | null; remote_url: string | null;
  }>(
    // doc_chunks.sha is the file's blob sha; links need a commit, so use the HEAD the repo was last ingested at
    `select t.id, ${HEADLINE} as snippet, t.repo_key, t.path, t.line_start, t.line_end, r.last_ingested_sha as sha, r.remote_url
     from doc_chunks t left join repos r on r.key = t.repo_key where t.id = any($2)`,
    [opts.q, ranked.map((r) => r.id)],
  );
  return byRank(ranked, rows).map((r) => ({ source: "doc" as const, ...r }));
}
