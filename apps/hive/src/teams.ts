import type pg from "pg";
import type { Instance } from "./auth.js";

export const TEAM_ROLES = ["member", "reviewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_KEY_PATTERN = "^[a-z0-9-]+$";

export interface Team {
  key: string;
  name: string;
  created_at: string;
  members: { user_id: string; role: TeamRole }[];
  repos: string[];
}

export class TeamError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const TEAM_SELECT = `
  select t.key, t.name, t.created_at,
         coalesce((select json_agg(json_build_object('user_id', m.user_id, 'role', m.role) order by m.user_id)
                   from team_members m where m.team_key = t.key), '[]') as members,
         coalesce((select json_agg(r.repo_key order by r.repo_key) from team_repos r where r.team_key = t.key), '[]') as repos
  from teams t`;

/** Every team with its members (and their roles) and repos, by key. */
export async function listTeams(pool: pg.Pool): Promise<Team[]> {
  return (await pool.query<Team>(`${TEAM_SELECT} order by t.key`)).rows;
}

export async function getTeam(pool: pg.Pool, key: string): Promise<Team | null> {
  return (await pool.query<Team>(`${TEAM_SELECT} where t.key = $1`, [key])).rows[0] ?? null;
}

/** The teams a user is in and their role in each, by key. */
export async function teamsOf(pool: pg.Pool, userId: string): Promise<{ key: string; name: string; role: TeamRole }[]> {
  const { rows } = await pool.query<{ key: string; name: string; role: TeamRole }>(
    "select t.key, t.name, m.role from team_members m join teams t on t.key = m.team_key where m.user_id = $1 order by t.key",
    [userId],
  );
  return rows;
}

export async function createTeam(pool: pg.Pool, key: string, name: string): Promise<Team> {
  const { rowCount } = await pool.query("insert into teams (key, name) values ($1, $2) on conflict (key) do nothing", [key, name]);
  if (!rowCount) throw new TeamError(409, `team ${key} already exists`);
  return (await getTeam(pool, key))!;
}

/** Refused while any fact or playbook still lives in team:<key>, so nothing is left in a scope without a team. */
export async function deleteTeam(pool: pg.Pool, key: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rowCount } = await client.query("select 1 from teams where key = $1 for update", [key]);
    if (!rowCount) throw new TeamError(404, "no such team");
    const scope = `team:${key}`;
    const { rows } = await client.query<{ facts: number; playbooks: number }>(
      `select (select count(*)::int from facts where scope = $1) as facts,
              (select count(*)::int from playbooks where scope = $1) as playbooks`,
      [scope],
    );
    const { facts, playbooks } = rows[0]!;
    if (facts || playbooks) {
      throw new TeamError(409, `team ${key} still has ${facts} fact(s) and ${playbooks} playbook(s) in ${scope}`);
    }
    await client.query("delete from teams where key = $1", [key]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

async function requireTeam(pool: pg.Pool, key: string): Promise<void> {
  const { rowCount } = await pool.query("select 1 from teams where key = $1", [key]);
  if (!rowCount) throw new TeamError(404, "no such team");
}

/** Add a member, or change their role. */
export async function setMember(pool: pg.Pool, key: string, userId: string, role: TeamRole): Promise<Team> {
  await requireTeam(pool, key);
  await pool.query(
    `insert into team_members (team_key, user_id, role) values ($1, $2, $3)
     on conflict (team_key, user_id) do update set role = $3`,
    [key, userId, role],
  );
  return (await getTeam(pool, key))!;
}

export async function removeMember(pool: pg.Pool, key: string, userId: string): Promise<Team> {
  await requireTeam(pool, key);
  const { rowCount } = await pool.query("delete from team_members where team_key = $1 and user_id = $2", [key, userId]);
  if (!rowCount) throw new TeamError(404, `${userId} is not in team ${key}`);
  return (await getTeam(pool, key))!;
}

/** The repo must be registered. */
export async function addRepo(pool: pg.Pool, key: string, repoKey: string): Promise<Team> {
  await requireTeam(pool, key);
  const { rowCount } = await pool.query("select 1 from repos where key = $1", [repoKey]);
  if (!rowCount) throw new TeamError(404, "unknown repo");
  await pool.query("insert into team_repos (team_key, repo_key) values ($1, $2) on conflict do nothing", [key, repoKey]);
  return (await getTeam(pool, key))!;
}

export async function removeRepo(pool: pg.Pool, key: string, repoKey: string): Promise<Team> {
  await requireTeam(pool, key);
  const { rowCount } = await pool.query("delete from team_repos where team_key = $1 and repo_key = $2", [key, repoKey]);
  if (!rowCount) throw new TeamError(404, `team ${key} does not list ${repoKey}`);
  return (await getTeam(pool, key))!;
}

/** The teams a caller counts as their own: those they're in, plus those that list repoKey. Distinct, by key. */
export async function ownTeams(pool: pg.Pool, who: Pick<Instance, "user_id">, repoKey?: string): Promise<string[]> {
  const { rows } = await pool.query<{ team_key: string }>(
    `select team_key from team_members where user_id = $1
     union
     select team_key from team_repos where repo_key = $2
     order by team_key`,
    [who.user_id, repoKey ?? null],
  );
  return rows.map((r) => r.team_key);
}
