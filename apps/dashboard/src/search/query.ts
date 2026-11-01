export const SEARCH_K = 20;

export const SOURCES = ["fact", "conversation", "history", "commit", "doc"] as const;
export type Source = (typeof SOURCES)[number];

/** A non-fact hit from /v1/search; which optional fields are set depends on `source`. */
export interface Hit {
  source: Exclude<Source, "fact">;
  id: string;
  snippet: string;
  score: number;
  session_id?: string | null;
  repo_key?: string | null;
  path?: string;
  line_start?: number | null;
  line_end?: number | null;
  ref?: string | null;
  created_at?: string;
  subject?: string;
  sha?: string | null;
  remote_url?: string | null;
}

export interface SearchState {
  q: string;
  /** Never empty; every source when the URL doesn't say. */
  sources: Source[];
}

export function readSearch(search: string): SearchState {
  const p = new URLSearchParams(search);
  const picked = (p.get("source") ?? "").split(",").map((s) => s.trim());
  const sources = SOURCES.filter((s) => picked.includes(s));
  return { q: p.get("q")?.trim() ?? "", sources: sources.length ? sources : [...SOURCES] };
}

/** "?q=x&source=doc,commit"; source is left out when every chip is on. */
export function writeSearch(s: SearchState): string {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.sources.length < SOURCES.length) p.set("source", s.sources.join(","));
  const out = p.toString();
  return out ? `?${out}` : "";
}

export function apiUrl(s: SearchState): string {
  const source = s.sources.length < SOURCES.length ? s.sources.join(",") : "all";
  const p = new URLSearchParams({ q: s.q, source, k: String(SEARCH_K), include_candidates: "true" });
  return `/v1/search?${p}`;
}
