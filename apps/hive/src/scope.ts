import type pg from "pg";
import type { Instance } from "./auth.js";

export class ScopeError extends Error {}

/**
 * Normalise the scope a client asked for into the stored form.
 *   "global" | "personal" | "repo" (needs repoKey) | "repo:<key>" | "personal:<own user>"
 * Nobody can write into another user's personal scope.
 */
export function resolveScope(requested: string, instance: Instance, repoKey?: string): string {
  if (requested === "global") return "global";
  if (requested === "personal") return `personal:${instance.user_id}`;
  if (requested === "repo") {
    if (!repoKey) throw new ScopeError('scope "repo" needs repo_key');
    return `repo:${repoKey}`;
  }
  if (requested.startsWith("repo:") && requested.length > 5) return requested;
  if (requested.startsWith("personal:")) {
    if (requested !== `personal:${instance.user_id}`) throw new ScopeError("cannot write to another user's personal scope");
    return requested;
  }
  throw new ScopeError(`unknown scope ${JSON.stringify(requested)} (use global, repo, repo:<key>, or personal)`);
}

/**
 * SQL predicate for scopes an instance may READ: global, every repo scope (or just the given repos
 * when repoKey is given; the first is the main one), and its own user's personal scope. Never other people's personal facts.
 * Returns [sql, params] with placeholders starting at $start.
 */
export function readableScopes(instance: Pick<Instance, "user_id">, repoKey: string | string[] | undefined, start: number, col = "scope"): [string, unknown[]] {
  const own = `personal:${instance.user_id}`;
  const keys = typeof repoKey === "string" ? [repoKey] : (repoKey ?? []);
  if (keys.length === 1) return [`(${col} = 'global' or ${col} = $${start} or ${col} = $${start + 1})`, [`repo:${keys[0]}`, own]];
  if (keys.length) return [`(${col} = 'global' or ${col} = any($${start}) or ${col} = $${start + 1})`, [keys.map((k) => `repo:${k}`), own]];
  return [`(${col} = 'global' or ${col} like 'repo:%' or ${col} = $${start})`, [own]];
}

export const MAX_ALSO_REPOS = 3;

/**
 * Extra repos a read may also look in: trimmed, without duplicates or the main repo itself, split into
 * registered ones (`known`, in the order given) and the rest (`unknown`, not read). More than MAX_ALSO_REPOS is a ScopeError.
 */
export async function resolveAlsoRepos(pool: pg.Pool, repoKey: string, list: string[]): Promise<{ known: string[]; unknown: string[] }> {
  const keys = [...new Set(list.map((k) => k.trim()).filter(Boolean))].filter((k) => k !== repoKey);
  if (keys.length > MAX_ALSO_REPOS) throw new ScopeError(`also_repos takes at most ${MAX_ALSO_REPOS} repos`);
  if (!keys.length) return { known: [], unknown: [] };
  const { rows } = await pool.query<{ key: string }>("select key from repos where key = any($1)", [keys]);
  const registered = new Set(rows.map((r) => r.key));
  return { known: keys.filter((k) => registered.has(k)), unknown: keys.filter((k) => !registered.has(k)) };
}
