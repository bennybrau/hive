import { useEffect, useState } from "react";
import { apiFetch } from "../api";

export interface Team {
  key: string;
  name: string;
  created_at: string;
  members: { user_id: string; role: "member" | "reviewer" }[];
  repos: string[];
}

/** One of the caller's teams, from /v1/teams/mine. */
export interface MyTeam {
  key: string;
  name: string;
  role: "member" | "reviewer";
}

export type Level = "personal" | "repository" | "team" | "organisation";

/** What a fact needs for its level: the scope, and the server's labels when it sent them. */
export interface Labelled {
  scope: string;
  level?: Level;
  team?: string;
  team_name?: string;
  own_team?: boolean;
}

export interface FactLevel {
  level: Level;
  /** For a team fact: its key and name, and whether it is one of the caller's teams. */
  team?: { key: string; name: string; own: boolean };
}

function levelOfScope(scope: string): Level {
  if (scope.startsWith("personal:")) return "personal";
  if (scope.startsWith("repo:")) return "repository";
  if (scope.startsWith("team:")) return "team";
  return "organisation";
}

/** The server's labels when present; otherwise worked out from scope (the review queue isn't labelled). */
export function levelOf(fact: Labelled, teams: Team[] = [], mine: MyTeam[] = []): FactLevel {
  const level = fact.level ?? levelOfScope(fact.scope);
  if (level !== "team") return { level };
  const key = fact.team ?? fact.scope.slice("team:".length);
  const name = fact.team_name ?? teams.find((t) => t.key === key)?.name ?? key;
  const own = fact.own_team ?? mine.some((t) => t.key === key);
  return { level, team: { key, name, own } };
}

/** What a level is called in the dashboard, and who it reaches. */
export function levelLabel(fact: Labelled, teams: Team[] = [], mine: MyTeam[] = []): { label: string; hint: string } {
  const l = levelOf(fact, teams, mine);
  if (l.level === "personal") return { label: "Just me", hint: "Only your own agents." };
  if (l.level === "repository") {
    const key = fact.scope.slice("repo:".length);
    const name = key.slice(key.lastIndexOf("/") + 1);
    return { label: `Repo: ${name}`, hint: `Agents working in the ${name} repo.` };
  }
  if (l.team) return { label: `Team: ${l.team.name}`, hint: "This team first; others can still find it." };
  return { label: "Everyone", hint: "Agents in every repository, for every team." };
}

/** value is "" (any), "personal", "repository", "team:<key>" or "global". */
export function matchesLevel(fact: Labelled, value: string): boolean {
  if (!value) return true;
  if (value === "personal") return fact.scope.startsWith("personal:");
  if (value === "repository") return fact.scope.startsWith("repo:");
  return fact.scope === value;
}

/** Every team and the caller's own; both empty if either call fails. */
export function useTeams(): { teams: Team[]; mine: MyTeam[] } {
  const [state, setState] = useState<{ teams: Team[]; mine: MyTeam[] }>({ teams: [], mine: [] });
  useEffect(() => {
    let live = true;
    const get = async <T,>(path: string): Promise<T[]> => {
      const res = await apiFetch(path);
      if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
      return ((await res.json()) as { teams?: T[] }).teams ?? [];
    };
    Promise.all([get<Team>("/v1/teams"), get<MyTeam>("/v1/teams/mine")])
      .then(([teams, mine]) => live && setState({ teams, mine }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return state;
}
