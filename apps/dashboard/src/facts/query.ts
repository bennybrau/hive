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
  /** On a list page; search results don't carry it. */
  use_count?: number;
  metadata?: { asked?: boolean; replaces?: string };
}

/** The list's filters. All of it lives in the query string. */
export interface Filters {
  /** "" (anyone), personal, repo:<key>, team:<key> or global (see matchesLevel). */
  level: string;
  /** "" means Live (active), "any" means any status. */
  status: string;
  origin: string;
  kind: string;
  q: string;
  page: number;
}

const KEYS = ["status", "origin", "kind", "q"] as const;

/** A repo is one of the levels here; in the URL it stays level=repository&repo=<key>. */
export function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const page = Number.parseInt(p.get("page") ?? "", 10);
  const f = { page: Number.isFinite(page) && page > 0 ? page : 0 } as Filters;
  for (const k of KEYS) f[k] = p.get(k)?.trim() ?? "";
  if (f.status === "active") f.status = "";
  const level = p.get("level")?.trim() ?? "";
  const repo = p.get("repo")?.trim() ?? "";
  f.level = repo ? `repo:${repo}` : level === "repository" ? "" : level;
  return f;
}

/** "?level=personal&page=2", or "" when nothing is set. */
export function writeFilters(f: Filters): string {
  const p = new URLSearchParams();
  if (f.level.startsWith("repo:")) {
    p.set("level", "repository");
    p.set("repo", f.level.slice("repo:".length));
  } else if (f.level) p.set("level", f.level);
  for (const k of KEYS) if (f[k]) p.set(k, f[k]);
  if (f.page > 0) p.set("page", String(f.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function listUrl(f: Filters): string {
  const p = new URLSearchParams();
  if (f.level) p.set("scope", f.level);
  if (f.status !== "any") p.set("status", f.status || "active");
  if (f.origin) p.set("origin", f.origin);
  if (f.kind) p.set("kind", f.kind);
  p.set("limit", String(PAGE_SIZE));
  p.set("offset", String(f.page * PAGE_SIZE));
  return `/v1/facts?${p}`;
}

export function searchUrl(f: Filters): string {
  const p = new URLSearchParams({ q: f.q, source: "fact", k: String(SEARCH_K), include_candidates: "true" });
  if (f.level.startsWith("repo:")) p.set("repo_key", f.level.slice("repo:".length));
  return `/v1/search?${p}`;
}

/** Search can't filter server-side, so search results go through this. */
export function matchesFilters(fact: Fact, f: Filters): boolean {
  if (!matchesLevel(fact, f.level)) return false;
  if (f.status !== "any" && fact.status !== (f.status || "active")) return false;
  if (f.origin && fact.origin !== f.origin) return false;
  if (f.kind && fact.kind !== f.kind) return false;
  return true;
}
