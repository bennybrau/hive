import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, type Role } from "../api";
import type { Team } from "../levels/levels";
import { EmptyState, PageHeader } from "../ui";
import { ROLE, word } from "../words";

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The hive answered ${res.status}.`;
}

const teamPath = (key: string) => `/v1/teams/${encodeURIComponent(key)}`;

function CreateTeam({ onCreated }: { onCreated: (t: Team) => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/v1/teams", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim(), name: name.trim() }),
      });
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      onCreated(((await res.json()) as { team: Team }).team);
      setKey("");
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the team.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="teams-create" aria-label="New team" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor="t-key">Key</label>
        <input id="t-key" type="text" value={key} onChange={(e) => setKey(e.target.value)} placeholder="billing" />
      </div>
      <div className="field">
        <label htmlFor="t-name">Name</label>
        <input id="t-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing" />
      </div>
      <button type="submit" disabled={busy || !key.trim() || !name.trim()}>
        Create team
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function TeamItem({
  team,
  repoKeys,
  onChanged,
  onDeleted,
}: {
  team: Team;
  repoKeys: string[];
  onChanged: (t: Team) => void;
  onDeleted: (key: string) => void;
}) {
  const [user, setUser] = useState("");
  const [attach, setAttach] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** One change to this team; the reply is the team as it is now. */
  async function change(path: string, method: "PUT" | "DELETE", body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(teamPath(team.key) + path, {
        method,
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        setError(await errorOf(res));
        return false;
      }
      onChanged(((await res.json()) as { team: Team }).team);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the team.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addMember(e: FormEvent) {
    e.preventDefault();
    const id = user.trim();
    if (id && (await change(`/members/${encodeURIComponent(id)}`, "PUT", { role: "member" }))) setUser("");
  }

  async function attachRepo(e: FormEvent) {
    e.preventDefault();
    if (attach && (await change(`/repos/${encodeURIComponent(attach)}`, "PUT"))) setAttach("");
  }

  async function remove() {
    if (!confirm(`Delete the team "${team.name}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(teamPath(team.key), { method: "DELETE" });
      if (res.ok) onDeleted(team.key);
      else setError(await errorOf(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the team.");
    } finally {
      setBusy(false);
    }
  }

  const free = repoKeys.filter((k) => !team.repos.includes(k));
  const id = `team-${team.key}`;
  return (
    <li data-key={team.key}>
      <div className="teams-head">
        <h2>{team.name}</h2>
        <code>{team.key}</code>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
          Delete team
        </button>
      </div>

      <section aria-label={`Members of ${team.name}`}>
        <h3>Members</h3>
        {team.members.length === 0 ? (
          <p className="help">No members yet.</p>
        ) : (
          <ul className="teams-rows">
            {team.members.map((m) => (
              <li key={m.user_id}>
                <code>{m.user_id}</code>
                <span className="help" title={word(ROLE, m.role).hint || undefined}>
                  {word(ROLE, m.role).label}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${m.user_id}`}
                  onClick={() => void change(`/members/${encodeURIComponent(m.user_id)}`, "DELETE")}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="teams-add" onSubmit={(e) => void addMember(e)}>
          <div className="field">
            <label htmlFor={`${id}-user`}>User id</label>
            <input id={`${id}-user`} type="text" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <button type="submit" disabled={busy || !user.trim()}>
            Add
          </button>
        </form>
      </section>

      <section aria-label={`Repos of ${team.name}`}>
        <h3>Repos</h3>
        {team.repos.length === 0 ? (
          <p className="help">No repos attached.</p>
        ) : (
          <ul className="teams-rows">
            {team.repos.map((r) => (
              <li key={r}>
                <code>{r}</code>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Detach ${r}`}
                  onClick={() => void change(`/repos/${encodeURIComponent(r)}`, "DELETE")}
                >
                  Detach
                </button>
              </li>
            ))}
          </ul>
        )}
        {free.length > 0 && (
          <form className="teams-add" onSubmit={(e) => void attachRepo(e)}>
            <div className="field">
              <label htmlFor={`${id}-repo`}>Attach repo</label>
              <select id={`${id}-repo`} value={attach} onChange={(e) => setAttach(e.target.value)}>
                <option value="">Pick a repo</option>
                {free.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" disabled={busy || !attach}>
              Attach
            </button>
          </form>
        )}
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** /teams (curators): create and delete teams, and change their members and repos. */
export function Teams({ role }: { role: Role }) {
  if (role !== "curator") {
    return (
      <main className="page">
        <PageHeader title="Teams" />
        <p className="help" role="note" title={ROLE.curator!.hint}>
          Only a Curator can manage teams.
        </p>
      </main>
    );
  }
  return <TeamsAdmin />;
}

function TeamsAdmin() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [repoKeys, setRepoKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch("/v1/teams")
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return ((await res.json()) as { teams: Team[] }).teams;
      })
      .then((t) => live && setTeams(t))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load teams."));
    apiFetch("/v1/repos")
      .then((res) => (res.ok ? (res.json() as Promise<{ repos: { key: string }[] }>) : { repos: [] }))
      .then((body) => live && setRepoKeys((body.repos ?? []).map((r) => r.key)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const put = useCallback(
    (t: Team) =>
      setTeams((all) => {
        const rest = (all ?? []).filter((x) => x.key !== t.key);
        return [...rest, t].sort((a, b) => a.key.localeCompare(b.key));
      }),
    [],
  );
  const drop = useCallback((key: string) => setTeams((all) => (all ?? []).filter((x) => x.key !== key)), []);

  return (
    <main className="page teams-page">
      <PageHeader title="Teams" lede="A team's agents get its facts before anyone else's. Facts are never hidden between teams." />
      <CreateTeam onCreated={put} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!teams && !error && <p className="help">Loading teams…</p>}
      {teams && teams.length === 0 && (
        <EmptyState title="No teams yet">Create one to give its members' agents their own conventions first.</EmptyState>
      )}
      {teams && teams.length > 0 && (
        <ul className="teams-list">
          {teams.map((t) => (
            <TeamItem key={t.key} team={t} repoKeys={repoKeys} onChanged={put} onDeleted={drop} />
          ))}
        </ul>
      )}
    </main>
  );
}
