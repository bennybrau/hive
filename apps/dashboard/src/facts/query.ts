import { matchesLevel, type Labelled } from "../levels/levels";

export const PAGE_SIZE = 50;
export const SEARCH_K = 100;

export const STATUSES = ["candidate", "active", "superseded", "retracted"] as const;
export const ORIGINS = ["authored", "distilled", "ingested"] as const;
export const KINDS = ["decision", "invariant", "gotcha", "preference", "convention", "system"] as const;

export interface Fact extends Labelled {
  id: string;
  text: string;
  kind: string;
  locus: string[];
  origin: string;
  status: string;
  status_note: string | null;
  author_user_id: string | null;
  recorded_at: string;
  metadata?: { asked?: boolean; replaces?: string };
}

/** The table's filters; "" means any. All of it lives in the query string. */
export interface Filters {
  /** "", personal, repository, team:<key> or global (see matchesLevel). */
  level: string;
  status: string;
  origin: string;
  kind: string;
  repo: string;
  q: string;
  page: number;
}

const KEYS = ["level", "status", "origin", "kind", "repo", "q"] as const;

export function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const page = Number.parseInt(p.get("page") ?? "", 10);
  const f = { page: Number.isFinite(page) && page > 0 ? page : 0 } as Filters;
  for (const k of KEYS) f[k] = p.get(k)?.trim() ?? "";
  return f;
}

/** "?level=personal&page=2", or "" when nothing is set. */
export function writeFilters(f: Filters): string {
  const p = new URLSearchParams();
  for (const k of KEYS) if (f[k]) p.set(k, f[k]);
  if (f.page > 0) p.set("page", String(f.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** A repo pick narrows to that repo's scope; otherwise the level, but the server has no scope for "any repo". */
function scopeParam(f: Filters): string {
  if (f.repo) return `repo:${f.repo}`;
  return f.level === "repository" ? "" : f.level;
}

export function listUrl(f: Filters): string {
  const p = new URLSearchParams();
  const scope = scopeParam(f);
  if (scope) p.set("scope", scope);
  if (f.status) p.set("status", f.status);
  if (f.origin) p.set("origin", f.origin);
  if (f.kind) p.set("kind", f.kind);
  p.set("limit", String(PAGE_SIZE));
  p.set("offset", String(f.page * PAGE_SIZE));
  return `/v1/facts?${p}`;
}

export function searchUrl(f: Filters): string {
  const p = new URLSearchParams({ q: f.q, source: "fact", k: String(SEARCH_K), include_candidates: "true" });
  if (f.repo) p.set("repo_key", f.repo);
  return `/v1/search?${p}`;
}

/** Search can't filter server-side, so search results go through this; so does a list page for the Repository level. */
export function matchesFilters(fact: Fact, f: Filters): boolean {
  if (!matchesLevel(fact, f.repo ? `repo:${f.repo}` : f.level)) return false;
  if (f.status && fact.status !== f.status) return false;
  if (f.origin && fact.origin !== f.origin) return false;
  if (f.kind && fact.kind !== f.kind) return false;
  return true;
}
