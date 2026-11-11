import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { apiFetch } from "../api";
import { navigate } from "../App";
import { githubBlobUrl } from "../facts/github";
import type { Fact } from "../facts/query";
import { LevelBadge } from "../levels/LevelBadge";
import { LevelFilter } from "../levels/LevelFilter";
import { matchesLevel, useTeams } from "../levels/levels";
import { apiUrl, readSearch, SOURCES, writeSearch, type Hit, type SearchState, type Source } from "./query";

const LABELS: Record<Source, string> = {
  fact: "Facts",
  conversation: "Conversations",
  history: "History",
  commit: "Commits",
  doc: "Docs",
};

/** ts_headline marks matches with <b>…</b>; show those as <mark> without trusting the rest as HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/<\/?b>/);
  return <p className="snippet">{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</p>;
}

function lines(h: Hit): string {
  if (!h.line_start) return "";
  return !h.line_end || h.line_end === h.line_start ? `:${h.line_start}` : `:${h.line_start}-${h.line_end}`;
}

function HitItem({ hit }: { hit: Hit }) {
  let head: ReactNode;
  if (hit.source === "doc") {
    const where = `${hit.path}${lines(hit)}`;
    const href = githubBlobUrl(hit.remote_url, hit.sha, hit.path, hit.line_start, hit.line_end);
    head = (
      <>
        <span className="repo">{hit.repo_key}</span>{" "}
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            <code>{where}</code>
          </a>
        ) : (
          <code>{where}</code>
        )}
      </>
    );
  } else if (hit.source === "commit") {
    head = (
      <>
        <span className="repo">{hit.repo_key}</span> <code>{hit.ref?.slice(0, 10)}</code> <strong>{hit.subject}</strong>
      </>
    );
  } else {
    head = (
      <>
        session <code>{hit.session_id ?? "?"}</code>
        {hit.created_at && (
          <>
            {" "}
            <time dateTime={hit.created_at}>{hit.created_at.slice(0, 10)}</time>
          </>
        )}
      </>
    );
  }
  return (
    <li data-source={hit.source}>
      <div className="meta">
        <span className="badge">{hit.source}</span> {head}
      </div>
      <Snippet text={hit.snippet} />
    </li>
  );
}

/** /search?q=&source=: facts first, then everything else ranked together. */
export function Search() {
  const [search, setSearch] = useState(location.search);
  useEffect(() => {
    const update = () => setSearch(location.search);
    addEventListener("popstate", update);
    return () => removeEventListener("popstate", update);
  }, []);

  const state = useMemo(() => readSearch(search), [search]);
  const [draft, setDraft] = useState(state.q);
  useEffect(() => setDraft(state.q), [state.q]);

  const [body, setBody] = useState<{ facts: Fact[]; results: Hit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { teams, mine } = useTeams();
  // Narrows fact results only; other sources have no level.
  const [level, setLevel] = useState("");
  const facts = useMemo(() => body?.facts.filter((f) => matchesLevel(f, level)) ?? [], [body, level]);

  const set = useCallback((s: SearchState) => {
    history.replaceState(null, "", location.pathname + writeSearch(s));
    setSearch(location.search);
  }, []);

  const url = state.q ? apiUrl(state) : null;
  useEffect(() => {
    setBody(null);
    setError(null);
    if (!url) return;
    let live = true;
    apiFetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return (await res.json()) as { facts?: Fact[]; results?: Hit[] };
      })
      .then((b) => live && setBody({ facts: b.facts ?? [], results: b.results ?? [] }))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't search."));
    return () => {
      live = false;
    };
  }, [url]);

  function submit(e: FormEvent) {
    e.preventDefault();
    set({ ...state, q: draft.trim() });
  }

  function toggle(s: Source) {
    const on = state.sources.includes(s);
    if (on && state.sources.length === 1) return; // the last chip stays on
    set({ ...state, sources: SOURCES.filter((x) => (x === s ? !on : state.sources.includes(x))) });
  }

  return (
    <main className="page search-page">
      <h1>Search</h1>
      <div className="filters">
        <form role="search" className="field search" onSubmit={submit}>
          <label htmlFor="s-q">Search</label>
          <span>
            <input id="s-q" type="search" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit">Search</button>
          </span>
        </form>
        <div className="chips" role="group" aria-label="Sources">
          {SOURCES.map((s) => (
            <button key={s} type="button" aria-pressed={state.sources.includes(s)} onClick={() => toggle(s)}>
              {LABELS[s]}
            </button>
          ))}
        </div>
        <LevelFilter id="s-level" value={level} teams={teams} onChange={setLevel} />
      </div>

      {!state.q && <p className="help">Type a question or a few words to search facts, conversations, history, commits and docs.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {body && facts.length === 0 && body.results.length === 0 && <p className="help">No results.</p>}

      {facts.length > 0 && (
        <section aria-label="Facts">
          <h2>Facts</h2>
          <ul className="hits">
            {facts.map((f) => (
              <li key={f.id} data-source="fact">
                <div className="meta">
                  <span className="badge">{f.kind}</span> <LevelBadge fact={f} teams={teams} mine={mine} /> · {f.status}
                </div>
                <a
                  href={`/facts/${encodeURIComponent(f.id)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/facts/${encodeURIComponent(f.id)}`);
                  }}
                >
                  {f.text}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {body && body.results.length > 0 && (
        <section aria-label="Results">
          <h2>Results</h2>
          <ul className="hits">
            {body.results.map((h) => (
              <HitItem key={`${h.source}:${h.id}`} hit={h} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
