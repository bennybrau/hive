export const PAGE_SIZE = 50;
export const SEARCH_K = 100;

export const SCOPES = ["global", "personal"] as const;
export const STATUSES = ["candidate", "active", "superseded", "retracted"] as const;
export const ORIGINS = ["authored", "distilled", "ingested"] as const;
export const KINDS = ["decision", "invariant", "gotcha", "preference", "convention", "system"] as const;

export interface Fact {
  id: string;
  text: string;
  kind: string;
  scope: string;
  locus: string[];
  origin: string;
  status: string;
  status_note: string | null;
  author_user_id: string | null;
  recorded_at: string;
  metadata?: { asked?: boolean };
}

/** The table's filters; "" means any. All of it lives in the query string. */
export interface Filters {
  scope: string;
  status: string;
  origin: string;
  kind: string;
  repo: string;
  q: string;
  page: number;
}

const KEYS = ["scope", "status", "origin", "kind", "repo", "q"] as const;

export function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const page = Number.parseInt(p.get("page") ?? "", 10);
  const f = { page: Number.isFinite(page) && page > 0 ? page : 0 } as Filters;
  for (const k of KEYS) f[k] = p.get(k)?.trim() ?? "";
  return f;
}

/** "?scope=personal&page=2", or "" when nothing is set. */
export function writeFilters(f: Filters): string {
  const p = new URLSearchParams();
  for (const k of KEYS) if (f[k]) p.set(k, f[k]);
  if (f.page > 0) p.set("page", String(f.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** A repo pick narrows to that repo's scope; otherwise the scope select. */
function scopeParam(f: Filters): string {
  return f.repo ? `repo:${f.repo}` : f.scope;
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

/** Search can't filter server-side, so search results go through this. */
export function matchesFilters(fact: Fact, f: Filters): boolean {
  const scope = scopeParam(f);
  if (scope === "personal" ? !fact.scope.startsWith("personal:") : scope && fact.scope !== scope) return false;
  if (f.status && fact.status !== f.status) return false;
  if (f.origin && fact.origin !== f.origin) return false;
  if (f.kind && fact.kind !== f.kind) return false;
  return true;
}
