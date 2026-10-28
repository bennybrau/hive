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
 * SQL predicate for scopes an instance may READ: global, every repo scope (or just one repo
 * when repoKey is given), and its own user's personal scope. Never other people's personal facts.
 * Returns [sql, params] with placeholders starting at $start.
 */
export function readableScopes(instance: Instance, repoKey: string | undefined, start: number, col = "scope"): [string, unknown[]] {
  const own = `personal:${instance.user_id}`;
  if (repoKey) return [`(${col} = 'global' or ${col} = $${start} or ${col} = $${start + 1})`, [`repo:${repoKey}`, own]];
  return [`(${col} = 'global' or ${col} like 'repo:%' or ${col} = $${start})`, [own]];
}
