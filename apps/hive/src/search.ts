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
const TSQUERY = "replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery";

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

/** Reciprocal rank fusion of a keyword list and a meaning list (ids in rank order). */
export function fuse(keyword: string[], meaning: { id: string; similarity: number }[], k: number): Ranked[] {
  const acc = new Map<string, Ranked>();
  keyword.forEach((id, i) => {
    acc.set(id, { id, score: 1 / (RRF_K + i + 1), matched: ["keyword"], similarity: null });
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
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, k);
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
): Promise<Ranked[]> {
  const pool = deps.pool;
  const [where, params] = spec.filter;
  const depth = Math.max(k * 3, 30); // look deeper than k so fusion has material
  const kw = pool.query<{ id: string }>(
    `select t.id from ${spec.table} t
     where t.${spec.tsv} @@ ${TSQUERY} and ${where}
     order by ts_rank_cd(t.${spec.tsv}, ${TSQUERY}) desc
     limit ${depth}`,
    [q, ...params],
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
  const meaning = (vecRows?.rows ?? [])
    .map((r) => ({ id: r.id, similarity: Number(r.similarity) }))
    .filter((r) => r.similarity >= deps.minSimilarity);
  return fuse(kwRows.rows.map((r) => r.id), meaning, k);
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
  score: number;
  matched: Matched[];
  similarity: number | null;
}

export async function searchFacts(
  deps: SearchDeps,
  who: Instance,
  opts: { q: string; repoKey?: string; k: number; statuses: string[]; qvec: string | null },
): Promise<FactHit[]> {
  const [scopeSql, scopeParams] = readableScopes(who, opts.repoKey, 3, "t.scope");
  const filter: [string, unknown[]] = [`t.status = any($2) and ${scopeSql}`, [opts.statuses, ...scopeParams]];
  const ranked = await hybridIds(deps, { table: "facts", tsv: "text_tsv", filter }, opts.q, opts.qvec, opts.k);
  if (ranked.length === 0) return [];
  const { rows } = await deps.pool.query<Fact & { anchors: number }>(
    `select ${FACT_COLUMNS.split(", ").map((c) => "f." + c).join(", ")},
            (select count(*)::int from anchors a where a.fact_id = f.id) as anchors
     from facts f where f.id = any($1)`,
    [ranked.map((r) => r.id)],
  );
  return byRank(ranked, rows);
}

export type EpisodeSource = "conversation" | "history";

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
  created_at?: string;
}

const HEADLINE = `ts_headline('english', left(t.content, 20000), ${TSQUERY}, 'MaxFragments=2, MaxWords=30, MinWords=10, FragmentDelimiter=" … "')`;

/** Conversations (turn episodes) and session history. Only the caller's own user's episodes. */
export async function searchEpisodes(
  deps: SearchDeps,
  who: Instance,
  source: EpisodeSource,
  opts: { q: string; k: number; qvec: string | null },
): Promise<TextHit[]> {
  const kind = source === "conversation" ? "turn" : "session";
  const filter: [string, unknown[]] = ["t.kind = $2 and t.user_id = $3", [kind, who.user_id]];
  const ranked = await hybridIds(deps, { table: "episodes", tsv: "content_tsv", filter }, opts.q, opts.qvec, opts.k);
  if (ranked.length === 0) return [];
  const { rows } = await deps.pool.query<{ id: string; snippet: string; session_id: string | null; repo_key: string | null; created_at: string }>(
    `select t.id, ${HEADLINE} as snippet, t.session_id, t.repo_key, t.created_at
     from episodes t where t.id = any($2)`,
    [opts.q, ranked.map((r) => r.id)],
  );
  return byRank(ranked, rows).map((r) => ({ source, ...r }));
}

export async function searchDocs(
  deps: SearchDeps,
  opts: { q: string; repoKey?: string; k: number; qvec: string | null },
): Promise<TextHit[]> {
  const filter: [string, unknown[]] = opts.repoKey ? ["t.repo_key = $2", [opts.repoKey]] : ["true", []];
  const ranked = await hybridIds(deps, { table: "doc_chunks", tsv: "content_tsv", filter }, opts.q, opts.qvec, opts.k);
  if (ranked.length === 0) return [];
  const { rows } = await deps.pool.query<{ id: string; snippet: string; repo_key: string; path: string }>(
    `select t.id, ${HEADLINE} as snippet, t.repo_key, t.path from doc_chunks t where t.id = any($2)`,
    [opts.q, ranked.map((r) => r.id)],
  );
  return byRank(ranked, rows).map((r) => ({ source: "doc" as const, ...r }));
}
