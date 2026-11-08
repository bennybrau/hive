import { useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, type Role } from "../api";
import { navigate } from "../App";
import { getPlaybook, listPlaybooks, retractPlaybook, type Playbook, type PlaybookItem } from "./api";
import { PlaybookForm } from "./PlaybookForm";

function Link({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

const playbookPath = (id: string) => `/playbooks/${encodeURIComponent(id)}`;

function Chips({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <span className="chips" aria-label={label}>
      {values.map((v) => (
        <code key={v} className="badge">
          {v}
        </code>
      ))}
    </span>
  );
}

/** Loads a playbook by id; `null` while loading. */
function usePlaybook(id: string): { playbook: Playbook | null; error: string | null } {
  const [state, setState] = useState<{ id: string; playbook: Playbook | null; error: string | null }>({ id, playbook: null, error: null });
  useEffect(() => {
    let live = true;
    getPlaybook(id)
      .then((playbook) => live && setState({ id, playbook, error: null }))
      .catch((err: unknown) => live && setState({ id, playbook: null, error: err instanceof Error ? err.message : "Couldn't load it." }));
    return () => {
      live = false;
    };
  }, [id]);
  return state.id === id ? state : { playbook: null, error: null };
}

/** Every curator page under /playbooks. */
export function Playbooks({ role, path }: { role: Role; path: string }) {
  if (role !== "curator") {
    return (
      <main className="page">
        <h1>Playbooks</h1>
        <p className="help" role="note">
          Playbooks are for curators only.
        </p>
      </main>
    );
  }
  const rest = path.slice("/playbooks/".length);
  if (path === "/playbooks" || rest === "") return <PlaybookList />;
  if (rest === "new") return <NewPlaybook />;
  if (rest.endsWith("/edit")) return <EditPlaybook id={decodeURIComponent(rest.slice(0, -"/edit".length))} />;
  return <PlaybookView id={decodeURIComponent(rest)} />;
}

function PlaybookList() {
  const [playbooks, setPlaybooks] = useState<Playbook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("");

  useEffect(() => {
    let live = true;
    listPlaybooks()
      .then((p) => live && setPlaybooks(p))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load playbooks."));
    return () => {
      live = false;
    };
  }, []);

  // Global first, then the repos by name.
  const scopes = useMemo(
    () => [...new Set((playbooks ?? []).map((p) => p.scope))].sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b))),
    [playbooks],
  );
  const shown = scopes.filter((s) => !scope || s === scope);

  return (
    <main className="page playbooks-page">
      <header className="playbook-head">
        <h1>Playbooks</h1>
        <button type="button" onClick={() => navigate("/playbooks/new")}>
          New playbook
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!playbooks && !error && <p className="help">Loading…</p>}
      {playbooks?.length === 0 && <p className="help">No playbooks yet.</p>}
      {scopes.length > 1 && (
        <div className="chips" role="group" aria-label="Scope">
          <button type="button" aria-pressed={scope === ""} onClick={() => setScope("")}>
            All
          </button>
          {scopes.map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {shown.map((s) => (
        <section key={s} aria-label={s}>
          <h2>{s}</h2>
          <ul className="playbooks-list">
            {playbooks!
              .filter((p) => p.scope === s)
              .map((p) => (
                <li key={p.id}>
                  <Link to={playbookPath(p.id)}>{p.title}</Link>
                  <Chips label="Path globs" values={p.applies_paths} />
                  <Chips label="Task words" values={p.applies_words} />
                </li>
              ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function NewPlaybook() {
  return (
    <main className="page">
      <h1>New playbook</h1>
      <PlaybookForm onSaved={(p) => navigate(playbookPath(p.id))} onCancel={() => navigate("/playbooks")} />
    </main>
  );
}

function EditPlaybook({ id }: { id: string }) {
  const { playbook, error } = usePlaybook(id);
  return (
    <main className="page">
      <h1>Edit playbook</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!playbook && !error && <p className="help">Loading…</p>}
      {playbook && (
        <PlaybookForm
          key={playbook.id}
          initial={playbook}
          onSaved={(p) => navigate(playbookPath(p.id))}
          onCancel={() => navigate(playbookPath(id))}
        />
      )}
    </main>
  );
}

/** The text of each linked fact, fetched once per id; missing ids stay absent. */
function useFactTexts(ids: string[]): Map<string, string> {
  const [texts, setTexts] = useState(() => new Map<string, string>());
  const key = ids.join(",");
  useEffect(() => {
    let live = true;
    for (const id of new Set(key ? key.split(",") : [])) {
      apiFetch(`/v1/facts/${encodeURIComponent(id)}`)
        .then(async (res) => (res.ok ? ((await res.json()) as { fact: { text: string } }).fact.text : null))
        .then((text) => live && text !== null && setTexts((m) => new Map(m).set(id, text)))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [key]);
  return texts;
}

function Items({ items, facts, ordered }: { items: PlaybookItem[]; facts: Map<string, string>; ordered?: boolean }) {
  const List = ordered ? "ol" : "ul";
  return (
    <List>
      {items.map((item, i) => (
        <li key={i}>
          {item.text}
          {item.fact_ids.length > 0 && (
            <ul className="playbook-facts">
              {item.fact_ids.map((f) => (
                <li key={f} className="help">
                  <Link to={`/facts/${encodeURIComponent(f)}`}>{facts.get(f) ?? f}</Link>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </List>
  );
}

function PlaybookView({ id }: { id: string }) {
  const { playbook: p, error } = usePlaybook(id);
  const [retracting, setRetracting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const factIds = useMemo(() => (p ? [...p.steps, ...p.pitfalls].flatMap((i) => i.fact_ids) : []), [p]);
  const facts = useFactTexts(factIds);

  async function retract() {
    if (!p || !confirm(`Retract "${p.title}"? Briefs stop including it.`)) return;
    setRetracting(true);
    setActionError(null);
    try {
      await retractPlaybook(p.id);
      navigate("/playbooks");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't retract it.");
      setRetracting(false);
    }
  }

  return (
    <main className="page">
      <p className="help">
        <Link to="/playbooks">← Playbooks</Link>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!p && !error && <p className="help">Loading…</p>}
      {p && (
        <article className="fact-detail playbook-detail" aria-label="Playbook">
          <header className="playbook-head">
            <h1>{p.title}</h1>
            <code className="badge">{p.scope}</code>
            {p.status !== "active" && <span className="badge">{p.status}</span>}
          </header>
          {p.supersedes && (
            <p className="help">
              Version of <Link to={playbookPath(p.supersedes)}>{p.supersedes.slice(0, 8)}</Link>
            </p>
          )}
          {(p.applies_paths.length > 0 || p.applies_words.length > 0) && (
            <>
              <h3>When it applies</h3>
              <dl>
                {p.applies_paths.length > 0 && (
                  <>
                    <dt>Paths</dt>
                    <dd>
                      <Chips label="Path globs" values={p.applies_paths} />
                    </dd>
                  </>
                )}
                {p.applies_words.length > 0 && (
                  <>
                    <dt>Task words</dt>
                    <dd>
                      <Chips label="Task words" values={p.applies_words} />
                    </dd>
                  </>
                )}
              </dl>
            </>
          )}
          <h3>Steps</h3>
          {p.steps.length ? <Items items={p.steps} facts={facts} ordered /> : <p className="help">None.</p>}
          <h3>Pitfalls</h3>
          {p.pitfalls.length ? <Items items={p.pitfalls} facts={facts} /> : <p className="help">None.</p>}
          {actionError && (
            <p className="error" role="alert">
              {actionError}
            </p>
          )}
          {p.status === "active" && (
            <span className="playbook-actions">
              <button type="button" onClick={() => navigate(`${playbookPath(p.id)}/edit`)}>
                Edit
              </button>
              <button type="button" disabled={retracting} onClick={retract}>
                {retracting ? "Retracting…" : "Retract"}
              </button>
            </span>
          )}
        </article>
      )}
    </main>
  );
}
