import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { apiFetch } from "../api";
import { LevelBadge } from "../levels/LevelBadge";
import { LevelFilter } from "../levels/LevelFilter";
import { useTeams } from "../levels/levels";
import { EmptyState } from "../ui";
import { KIND, ORIGIN, STATUS, when, word, type Word } from "../words";
import {
  KINDS,
  listUrl,
  matchesFilters,
  ORIGINS,
  SEARCH_K,
  searchUrl,
  STATUSES,
  type Fact,
  type Filters,
} from "./query";

interface Repo {
  key: string;
}

interface Props {
  filters: Filters;
  onChange: (f: Filters) => void;
  openId: string | null;
  onOpen: (id: string) => void;
}

function Select({
  id,
  label,
  value,
  options,
  words,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  /** Labels for the options; the option value stays the API value. Without one, the value is the text. */
  words?: Record<string, Word>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {words ? word(words, o).label : o}
          </option>
        ))}
      </select>
    </div>
  );
}

function Cell({ w }: { w: Word }) {
  return <td title={w.hint || undefined}>{w.label}</td>;
}

function Recorded({ iso }: { iso: string }) {
  const t = when(iso);
  return (
    <time dateTime={iso} title={t.title}>
      {t.text}
    </time>
  );
}

export function FactsTable({ filters, onChange, openId, onOpen }: Props) {
  const searching = filters.q !== "";
  const [rows, setRows] = useState<Fact[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [draft, setDraft] = useState(filters.q);
  const [active, setActive] = useState(0);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const { teams, mine } = useTeams();

  useEffect(() => setDraft(filters.q), [filters.q]);

  useEffect(() => {
    let live = true;
    apiFetch("/v1/repos")
      .then((res) => (res.ok ? (res.json() as Promise<{ repos: Repo[] }>) : { repos: [] }))
      .then((body) => live && setRepos(body.repos ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const url = searching ? searchUrl(filters) : listUrl(filters);
  useEffect(() => {
    let live = true;
    setError(null);
    apiFetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return (await res.json()) as { facts: Fact[]; has_more?: boolean };
      })
      .then((body) => {
        if (!live) return;
        setRows(body.facts ?? []);
        setHasMore(body.has_more ?? false);
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load facts."));
    return () => {
      live = false;
    };
  }, [url]);

  // The server can filter a list page by every level but Repository; that one narrows the loaded page here.
  const narrow = searching || (filters.level === "repository" && !filters.repo);
  const shown = useMemo(
    () => (rows && narrow ? rows.filter((f) => matchesFilters(f, filters)) : rows),
    [rows, narrow, filters],
  );

  // Keep the roving row on the open fact when it's in view, else in range.
  useEffect(() => {
    if (!shown) return;
    const i = openId ? shown.findIndex((f) => f.id === openId) : -1;
    setActive((a) => (i >= 0 ? i : Math.min(a, Math.max(shown.length - 1, 0))));
  }, [shown, openId]);

  const set = (patch: Partial<Filters>) => onChange({ ...filters, page: 0, ...patch });

  function submit(e: FormEvent) {
    e.preventDefault();
    set({ q: draft.trim() });
  }

  function onRowKey(e: KeyboardEvent, i: number) {
    if (!shown) return;
    let next = i;
    if (e.key === "ArrowDown" || e.key === "j") next = Math.min(i + 1, shown.length - 1);
    else if (e.key === "ArrowUp" || e.key === "k") next = Math.max(i - 1, 0);
    else if (e.key === "Enter") {
      e.preventDefault();
      onOpen(shown[i]!.id);
      return;
    } else return;
    e.preventDefault();
    setActive(next);
    rowRefs.current[next]?.focus();
  }

  return (
    <section className="facts-list" aria-label="Facts list">
      <div className="filters">
        <LevelFilter id="f-level" value={filters.level} teams={teams} onChange={(level) => set({ level })} />
        <Select
          id="f-repo"
          label="Repo"
          value={filters.repo}
          options={repos.map((r) => r.key)}
          onChange={(repo) => set({ repo })}
        />
        <Select id="f-status" label="Status" value={filters.status} options={STATUSES} words={STATUS} onChange={(status) => set({ status })} />
        <Select id="f-origin" label="Origin" value={filters.origin} options={ORIGINS} words={ORIGIN} onChange={(origin) => set({ origin })} />
        <Select id="f-kind" label="Kind" value={filters.kind} options={KINDS} words={KIND} onChange={(kind) => set({ kind })} />
        <form role="search" className="field search" onSubmit={submit}>
          <label htmlFor="f-q">Search</label>
          <span>
            <input id="f-q" type="search" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit">Search</button>
          </span>
        </form>
      </div>

      {searching && (
        <p className="help" role="note">
          Showing up to {SEARCH_K} matches; filters applied here, no paging.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {shown && (
        <table className="facts">
          <thead>
            <tr>
              <th scope="col">Text</th>
              <th scope="col">Kind</th>
              <th scope="col">Level</th>
              <th scope="col">Status</th>
              <th scope="col">Origin</th>
              <th scope="col">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f, i) => (
              <tr
                key={f.id}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                data-id={f.id}
                tabIndex={i === active ? 0 : -1}
                aria-current={f.id === openId ? "true" : undefined}
                onFocus={() => setActive(i)}
                onClick={() => onOpen(f.id)}
                onKeyDown={(e) => onRowKey(e, i)}
              >
                <td className="text">{f.text}</td>
                <Cell w={word(KIND, f.kind)} />
                <td>
                  <LevelBadge fact={f} teams={teams} mine={mine} />
                </td>
                <Cell w={word(STATUS, f.status)} />
                <Cell w={word(ORIGIN, f.origin)} />
                <td>
                  <Recorded iso={f.recorded_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown?.length === 0 && (
        <EmptyState title="Nothing matches these filters">
          Facts appear here when a person writes one, when Hive learns one from a conversation and a curator approves
          it, or when Hive reads one from a repo's docs or code.
        </EmptyState>
      )}

      {!searching && (
        <nav className="pager" aria-label="Pages">
          <button type="button" disabled={filters.page === 0} onClick={() => onChange({ ...filters, page: filters.page - 1 })}>
            Prev
          </button>
          <span className="help">Page {filters.page + 1}</span>
          <button type="button" disabled={!hasMore} onClick={() => onChange({ ...filters, page: filters.page + 1 })}>
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
