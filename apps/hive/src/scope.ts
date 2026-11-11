import type pg from "pg";
import type { Instance } from "./auth.js";

export class ScopeError extends Error {}
/** The team named in a team scope doesn't exist (404). */
export class ScopeNotFound extends ScopeError {}
/** The caller may not write into that scope (403). */
export class ScopeForbidden extends ScopeError {}

/**
 * Normalise the scope a client asked for into the stored form.
 *   "global" | "personal" | "repo" (needs repoKey) | "repo:<key>" | "personal:<own user>" | "team" | "team:<key>"
 * Nobody can write into another user's personal scope. "team" takes opts.team, else the caller's one team membership
 * (team_repos don't count); a team's members and any curator may write into it.
 */
export async function resolveScope(
  pool: pg.Pool,
  requested: string,
  instance: Instance,
  opts: { repoKey?: string; team?: string } = {},
): Promise<string> {
  const { repoKey, team } = opts;
  if (requested === "team" || requested.startsWith("team:")) return `team:${await resolveTeam(pool, requested, instance, team)}`;
  if (team !== undefined) throw new ScopeError(`team only goes with scope "team" or "team:<key>", not ${JSON.stringify(requested)}`);
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
  throw new ScopeError(`unknown scope ${JSON.stringify(requested)} (use global, repo, repo:<key>, personal, team or team:<key>)`);
}

/** The team key a "team" or "team:<key>" scope means, once the caller is allowed to write there. */
async function resolveTeam(pool: pg.Pool, requested: string, instance: Instance, team: string | undefined): Promise<string> {
  let key = requested === "team" ? team : requested.slice(5);
  if (requested !== "team" && team !== undefined && team !== key) {
    throw new ScopeError(`team ${JSON.stringify(team)} conflicts with scope ${JSON.stringify(requested)}`);
  }
  if (!key) {
    const { rows } = await pool.query<{ team_key: string }>("select team_key from team_members where user_id = $1 order by team_key", [
      instance.user_id,
    ]);
    if (rows.length !== 1) {
      throw new ScopeError(
        rows.length
          ? `you are in several teams (${rows.map((r) => r.team_key).join(", ")}); say which with team`
          : 'you are in no team; say which with team, or use scope "team:<key>"',
      );
    }
    key = rows[0]!.team_key;
  }
  const { rows } = await pool.query<{ member: boolean }>(
    "select exists (select 1 from team_members where team_key = $1 and user_id = $2) as member from teams where key = $1",
    [key, instance.user_id],
  );
  if (!rows[0]) throw new ScopeNotFound(`no such team ${JSON.stringify(key)}`);
  if (!rows[0].member && instance.role !== "curator") throw new ScopeForbidden(`you are not in team ${key}`);
  return key;
}

/**
 * SQL predicate for scopes an instance may READ: global, every repo scope (or just the given repos
 * when repoKey is given; the first is the main one), every team scope, and its own user's personal scope. Never other
 * people's personal facts.
 * Returns [sql, params] with placeholders starting at $start.
 */
export function readableScopes(instance: Pick<Instance, "user_id">, repoKey: string | string[] | undefined, start: number, col = "scope"): [string, unknown[]] {
  const own = `personal:${instance.user_id}`;
  const keys = typeof repoKey === "string" ? [repoKey] : (repoKey ?? []);
  if (keys.length === 1) return [`(${col} = 'global' or ${col} = $${start} or ${col} like 'team:%' or ${col} = $${start + 1})`, [`repo:${keys[0]}`, own]];
  if (keys.length) return [`(${col} = 'global' or ${col} = any($${start}) or ${col} like 'team:%' or ${col} = $${start + 1})`, [keys.map((k) => `repo:${k}`), own]];
  return [`(${col} = 'global' or ${col} like 'repo:%' or ${col} like 'team:%' or ${col} = $${start})`, [own]];
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
