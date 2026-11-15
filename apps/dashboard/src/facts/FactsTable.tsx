import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { apiFetch } from "../api";
import { useTeams } from "../levels/levels";
import { Badge, Button, EmptyState, FactRow } from "../ui";
import { KIND, levelLabel, ORIGIN, STATUS, usedTimes, when, word, type Word } from "../words";
import {
  KINDS,
  listUrl,
  matchesFilters,
  ORIGINS,
  SEARCH_K,
  searchUrl,
  STATUSES,
  writeFilters,
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
  /** The open fact. It sits beside the rows, under the search box and the filter line. */
  pane?: ReactNode;
  /** Bumped after a save in the open fact, so the list fetches again. */
  reload: number;
}

interface Option {
  value: string;
  label: string;
}

const opts = (values: readonly string[], words: Record<string, Word>): Option[] =>
  values.map((v) => ({ value: v, label: word(words, v).label }));

const STATUS_OPTIONS: Option[] = [
  { value: "", label: STATUS.active!.label },
  ...opts(
    STATUSES.filter((s) => s !== "active"),
    STATUS,
  ),
  { value: "any", label: "Any status" },
];
const KIND_OPTIONS: Option[] = [{ value: "", label: "Any kind" }, ...opts(KINDS, KIND)];
const ORIGIN_OPTIONS: Option[] = [{ value: "", label: "From anywhere" }, ...opts(ORIGINS, ORIGIN)];

/**
 * A quiet menu that reads as its current value; `.set` once it's off its default (the first option).
 * The words and the chevron are drawn here and the native select lies invisible on top of them: a select
 * is as wide as its longest option, so four of them drawn directly don't fit on one line.
 */
function Menu({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <span className={value ? "menu set" : "menu"}>
      <span className="now" aria-hidden="true">
        {current?.label}
      </span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function FactsTable({ filters, onChange, openId, onOpen, pane, reload }: Props) {
  const searching = filters.q !== "";
  const [body, setBody] = useState<{ facts: Fact[]; has_more?: boolean; total?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [draft, setDraft] = useState(filters.q);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
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
        return (await res.json()) as { facts: Fact[]; has_more?: boolean; total?: number };
      })
      .then((b) => live && setBody({ ...b, facts: b.facts ?? [] }))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load facts."));
    return () => {
      live = false;
    };
  }, [url, reload]);

  // A list page comes back filtered by the server; search can't filter, so its hits are narrowed here.
  const shown = useMemo(
    () => (body && searching ? body.facts.filter((f) => matchesFilters(f, filters)) : (body?.facts ?? null)),
    [body, searching, filters],
  );

  // Who gets it: a repo is one of the levels. A level from the URL that isn't loaded (yet) still shows as itself.
  const levels = useMemo(() => {
    const o: Option[] = [
      { value: "", label: "For anyone" },
      { value: "personal", label: "Just me" },
      ...repos.map((r) => ({ value: `repo:${r.key}`, label: levelLabel({ scope: `repo:${r.key}` }).label })),
      ...teams.map((t) => ({ value: `team:${t.key}`, label: `Team: ${t.name}` })),
      { value: "global", label: "Everyone" },
    ];
    if (!o.some((x) => x.value === filters.level)) {
      o.splice(o.length - 1, 0, { value: filters.level, label: levelLabel({ scope: filters.level }).label });
    }
    return o;
  }, [repos, teams, filters.level]);

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
    listRef.current?.querySelectorAll<HTMLElement>("[data-id]")[next]?.focus();
  }

  const query = writeFilters(filters);

  return (
    <section className="facts-list" aria-label="Facts list">
      <form role="search" className="search" onSubmit={submit}>
        <label htmlFor="facts-q">Search facts</label>
        <input
          id="facts-q"
          type="search"
          placeholder="A topic, a repo, a word"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>

      <div className="filterbar">
        {shown && (
          <p className="count">
            {searching ? (
              <>
                <b>{shown.length}</b> {shown.length === 1 ? "match" : "matches"}, best first
              </>
            ) : (
              <>
                <b>{body?.total ?? shown.length}</b> {(body?.total ?? shown.length) === 1 ? "fact" : "facts"}, newest first
              </>
            )}
          </p>
        )}
        <div className="menus" role="group" aria-label="Filters">
          <Menu label="Status" value={filters.status} options={STATUS_OPTIONS} onChange={(status) => set({ status })} />
          <Menu label="Who gets it" value={filters.level} options={levels} onChange={(level) => set({ level })} />
          <Menu label="Kind" value={filters.kind} options={KIND_OPTIONS} onChange={(kind) => set({ kind })} />
          <Menu label="Came from" value={filters.origin} options={ORIGIN_OPTIONS} onChange={(origin) => set({ origin })} />
        </div>
      </div>

      {searching && (
        <p className="help" role="note">
          At most {SEARCH_K} matches are shown.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="kn-split">
        <div className="kn-col">
        {shown && shown.length > 0 && (
          <div className="kn-list" ref={listRef}>
            {shown.map((f, i) => {
              const who = levelLabel(f, teams, mine);
              const t = when(f.recorded_at);
              return (
                <FactRow
                  key={f.id}
                  href={`/facts/${encodeURIComponent(f.id)}${query}`}
                  data-id={f.id}
                  tabIndex={i === active ? 0 : -1}
                  current={f.id === openId}
                  onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    onOpen(f.id);
                  }}
                  onFocus={() => setActive(i)}
                  onKeyDown={(e) => onRowKey(e, i)}
                  text={f.text}
                  badge={
                    <Badge tone="who" title={f.scope}>
                      {who.label}
                    </Badge>
                  }
                  meta={
                    <>
                      {word(KIND, f.kind).label},{" "}
                      {f.status !== "active" && <>{word(STATUS, f.status).label}, </>}
                      <time dateTime={f.recorded_at} title={t.title}>
                        {t.text}
                      </time>
                    </>
                  }
                  used={f.use_count !== undefined ? usedTimes(f.use_count) : undefined}
                />
              );
            })}
          </div>
        )}
        {shown?.length === 0 && (
          <EmptyState title="Nothing matches these filters">
            Facts appear here when a person writes one, when Hive learns one from a conversation and a curator approves
            it, or when Hive reads one from a repo's docs or code.
          </EmptyState>
        )}

        {!searching && (
          <nav className="pages" aria-label="Pages">
            <Button variant="quiet" disabled={filters.page === 0} onClick={() => onChange({ ...filters, page: filters.page - 1 })}>
              Previous
            </Button>
            <span className="help">Page {filters.page + 1}</span>
            <Button variant="quiet" disabled={!body?.has_more} onClick={() => onChange({ ...filters, page: filters.page + 1 })}>
              Next
            </Button>
          </nav>
        )}
        </div>
        {pane}
      </div>
    </section>
  );
}
