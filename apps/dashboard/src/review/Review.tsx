import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { apiFetch, type Role } from "../api";
import { navigate } from "../App";
import type { Fact } from "../facts/query";
import { LevelBadge } from "../levels/LevelBadge";
import { LevelFilter } from "../levels/LevelFilter";
import { matchesLevel, useTeams, type MyTeam, type Team } from "../levels/levels";
import { usePendingDecision, type Decision } from "./usePendingDecision";

interface Anchor {
  id: string;
  episode_id: string | null;
  repo_key: string | null;
  path: string | null;
  line_start: number | null;
  line_end: number | null;
  quote: string | null;
  verify_status: string;
  episode_snippet: string | null;
  /** The user turn the quote came from and what the bot said just before it; null when the quote is in no user turn. */
  exchange: { assistant: string | null; user: string } | null;
}

interface Similar {
  id: string;
  text: string;
  scope: string;
  similarity: number;
}

/** The fact a distilled candidate says it replaces, whatever its status now. */
interface Replaced {
  id: string;
  text: string;
  kind: string;
  scope: string;
  status: string;
}

export interface Candidate extends Fact {
  supersedes: string | null;
  anchors: Anchor[];
  similar: Similar[];
  replaces: Replaced | null;
}

/** An active fact a person corrected after an answer cited it, with the candidate that would replace it, if any. */
export interface Flagged extends Fact {
  correction: { text: string; episode_id: string; candidate_id: string | null; at: string };
  replacing: { id: string; text: string } | null;
}

interface Queue {
  candidates: Candidate[];
  flagged: Flagged[];
  last_distill_at: string | null;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
  ["year", Infinity],
];

/** "3 hours ago", "yesterday", … */
export function timeAgo(iso: string, now = Date.now()): string {
  let n = (Date.parse(iso) - now) / 1000;
  for (const [unit, per] of UNITS) {
    if (Math.abs(n) < per) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(n), unit);
    n /= per;
  }
  return "";
}

function lines(a: Anchor): string {
  if (!a.line_start) return "";
  return a.line_end && a.line_end !== a.line_start ? `:L${a.line_start}–L${a.line_end}` : `:L${a.line_start}`;
}

const DONE: Record<Decision["action"], string> = {
  approve: "Approved",
  fix: "Fixed",
  reject: "Rejected",
  keep: "Kept",
  retire: "Retired",
};

type Editing = { kind: "fix"; text: string } | { kind: "reject"; note: string } | null;

/** For the badge: the queue isn't labelled, so levels are worked out from scope and these. */
type Teams = { teams: Team[]; mine: MyTeam[] };

/** The decision buttons for the current candidate; on a phone they are the card's footer, pinned to the bottom of the screen. */
function Actions({
  c,
  teams,
  editing,
  setEditing,
  shareWith,
  setShareWith,
  submit,
  approve,
}: {
  c: Candidate;
  teams: Team[];
  editing: Editing;
  setEditing: (e: Editing) => void;
  shareWith: string;
  setShareWith: (s: string) => void;
  submit: () => void;
  approve: () => void;
}) {
  // Where an approve can move the candidate: "" keeps its scope; its own scope isn't offered.
  const share = [...teams.map((t) => ({ value: `team:${t.key}`, label: t.name })), { value: "global", label: "Organisation" }].filter(
    (o) => o.value !== c.scope,
  );
  const fixOk = editing?.kind !== "fix" || editing.text.trim().length >= 3;
  return (
    <div className="review-actions" role="group" aria-label="Decide">
      {editing ? (
        <>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
          {editing.kind === "fix" ? (
            <button type="button" className="primary" disabled={!fixOk} onClick={submit}>
              Save fix
            </button>
          ) : (
            <button type="button" className="danger" onClick={submit}>
              Reject
            </button>
          )}
        </>
      ) : (
        <>
          <button type="button" onClick={() => setEditing({ kind: "reject", note: "" })}>
            Reject…
          </button>
          <button type="button" onClick={() => setEditing({ kind: "fix", text: c.text })}>
            Fix…
          </button>
          <label className="share-with">
            Share with
            <select value={shareWith} onChange={(e) => setShareWith(e.target.value)}>
              <option value="">Keep</option>
              {share.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary" onClick={approve}>
            Approve
          </button>
        </>
      )}
    </div>
  );
}

function Evidence({
  c,
  levels,
  editing,
  setEditing,
  shareWith,
  setShareWith,
  submit,
  approve,
}: {
  c: Candidate;
  levels: Teams;
  editing: Editing;
  setEditing: (e: Editing) => void;
  shareWith: string;
  setShareWith: (s: string) => void;
  submit: () => void;
  approve: () => void;
}) {
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  // On a phone a long bot turn is cut to a few lines until asked for; the parent keys this by candidate, so it resets.
  const [botOpen, setBotOpen] = useState(false);
  // The first conversation the fact came from, shown as the exchange; its snippet would only repeat it.
  const shown = c.anchors.find((a) => a.exchange);
  // The replaced fact has its own section; don't list it again as similar.
  const old = c.replaces;
  const similar = c.similar.filter((s) => s.id !== old?.id);
  return (
    <aside className="review-evidence" aria-label="Evidence">
      {c.metadata?.asked && <span className="badge asked">asked to remember</span>}
      <p className="review-card-meta">
        {c.kind} · <LevelBadge fact={c} {...levels} /> · {c.origin}
      </p>
      {shown?.exchange && (
        <section className="exchange" aria-label="Exchange">
          {shown.exchange.assistant !== null && (
            <div className={botOpen ? "exchange-bot" : "exchange-bot clamped"}>
              <span className="exchange-label">bot said</span>
              <pre className="quote">{shown.exchange.assistant}</pre>
              {!botOpen && (
                <button type="button" className="link more" onClick={() => setBotOpen(true)}>
                  Show all of it
                </button>
              )}
            </div>
          )}
          <div className="exchange-user">
            <span className="exchange-label">you said</span>
            <pre className="quote">{shown.exchange.user}</pre>
          </div>
        </section>
      )}
      {editing?.kind === "fix" ? (
        <div className="field">
          <label htmlFor="r-fix">Fixed text</label>
          <textarea
            id="r-fix"
            autoFocus
            rows={4}
            value={editing.text}
            onChange={(e) => setEditing({ kind: "fix", text: e.target.value })}
            onKeyDown={onKey}
          />
          <p className="help keys-hint">Enter saves, Esc cancels.</p>
        </div>
      ) : (
        <p className="fact-text">{c.text}</p>
      )}
      {editing?.kind === "reject" && (
        <div className="field">
          <label htmlFor="r-note">Why reject it? (optional)</label>
          <input
            id="r-note"
            type="text"
            autoFocus
            value={editing.note}
            onChange={(e) => setEditing({ kind: "reject", note: e.target.value })}
            onKeyDown={onKey}
          />
          <p className="help keys-hint">Enter rejects, Esc cancels.</p>
        </div>
      )}
      <Actions
        c={c}
        teams={levels.teams}
        editing={editing}
        setEditing={setEditing}
        shareWith={shareWith}
        setShareWith={setShareWith}
        submit={submit}
        approve={approve}
      />
      {old && (
        <section className="replaces" aria-label="Replaces">
          <h3>Replaces</h3>
          <p className="old">{old.text}</p>
          <p className="help">
            <a
              href={`/facts/${encodeURIComponent(old.id)}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/facts/${encodeURIComponent(old.id)}`);
              }}
            >
              {old.id.slice(0, 8)}
            </a>{" "}
            {old.status === "active"
              ? "Approve or fix retires it. Reject leaves it as it is."
              : `Already ${old.status}. Approving won't change it.`}
          </p>
        </section>
      )}

      <h3>Anchors</h3>
      {c.anchors.length === 0 ? (
        <p className="help">None.</p>
      ) : (
        <ul className="anchors">
          {c.anchors.map((a) => (
            <li key={a.id}>
              {a.path ? (
                <code>
                  {a.repo_key ? `${a.repo_key} ` : ""}
                  {a.path}
                  {lines(a)}
                </code>
              ) : a.episode_id ? (
                <span className="help">From a conversation</span>
              ) : null}
              {a.quote && <pre className="quote">{a.quote}</pre>}
              {a.episode_snippet && a !== shown && <pre className="quote snippet">{a.episode_snippet}</pre>}
            </li>
          ))}
        </ul>
      )}

      {similar.length > 0 && (
        <>
          <h3>Similar active facts</h3>
          <ul className="similar">
            {similar.slice(0, 3).map((s) => (
              <li key={s.id}>
                <span className="pct">{Math.round(s.similarity * 100)}%</span> {s.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

type FlagEditing = { kind: "fix"; text: string } | { kind: "retire"; note: string } | null;

/** A flagged fact: what the person said, the candidate replacing it, and keep / fix / retire. */
function FlaggedCard({
  f,
  levels,
  candidateLoaded,
  selectCandidate,
  decide,
}: {
  f: Flagged;
  levels: Teams;
  candidateLoaded: boolean;
  selectCandidate: (id: string) => void;
  decide: (d: Decision) => void;
}) {
  const [editing, setEditing] = useState<FlagEditing>(null);
  const fixOk = editing?.kind === "fix" && editing.text.trim().length >= 3;

  function submit() {
    if (!editing) return;
    if (editing.kind === "fix") {
      if (!fixOk) return;
      decide({ id: f.id, via: "curate", action: "fix", new_text: editing.text.trim() });
    } else {
      const note = editing.note.trim();
      decide({ id: f.id, via: "curate", action: "retire", ...(note ? { note } : {}) });
    }
    setEditing(null);
  }
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  const replacing = f.replacing;
  const short = replacing?.id.slice(0, 8);

  return (
    <li className="flagged-card" data-id={f.id}>
      {editing?.kind === "fix" ? (
        <div className="field">
          <label htmlFor={`fl-fix-${f.id}`}>Fixed text</label>
          <textarea
            id={`fl-fix-${f.id}`}
            autoFocus
            rows={3}
            value={editing.text}
            onChange={(e) => setEditing({ kind: "fix", text: e.target.value })}
            onKeyDown={onKey}
          />
          <p className="help keys-hint">Enter saves, Esc cancels.</p>
        </div>
      ) : (
        <p className="fact-text">{f.text}</p>
      )}
      <p className="meta">
        {f.kind} in <LevelBadge fact={f} {...levels} />. Corrected {timeAgo(f.correction.at)}.
      </p>
      <blockquote className="quote">{f.correction.text}</blockquote>
      {replacing && (
        <p className="help">
          Replaced by candidate{" "}
          {candidateLoaded ? (
            <a
              href={`#${encodeURIComponent(replacing.id)}`}
              onClick={(e) => {
                e.preventDefault();
                selectCandidate(replacing.id);
              }}
            >
              {short}
            </a>
          ) : (
            short
          )}
        </p>
      )}
      {editing?.kind === "retire" && (
        <div className="field">
          <label htmlFor={`fl-note-${f.id}`}>Why retire it? (optional)</label>
          <input
            id={`fl-note-${f.id}`}
            type="text"
            autoFocus
            value={editing.note}
            onChange={(e) => setEditing({ kind: "retire", note: e.target.value })}
            onKeyDown={onKey}
          />
          <p className="help keys-hint">Enter retires, Esc cancels.</p>
        </div>
      )}
      <div className="stale-actions">
        {editing ? (
          <>
            {editing.kind === "fix" ? (
              <button type="button" disabled={!fixOk} onClick={submit}>
                Save fix
              </button>
            ) : (
              <button type="button" className="danger" onClick={submit}>
                Retire fact
              </button>
            )}
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => decide({ id: f.id, via: "curate", action: "keep" })}>
              Keep
            </button>
            <button type="button" onClick={() => setEditing({ kind: "fix", text: f.text })}>
              Fix
            </button>
            <button type="button" onClick={() => setEditing({ kind: "retire", note: "" })}>
              Retire
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/** Must match the breakpoint in styles.css where the review queue shows one card at a time. */
const SINGLE_CARD = "(max-width: 900px)";

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

/** The review queue: candidates oldest first beside their evidence, decided from the keyboard. */
export function Review({ role }: { role: Role }) {
  if (role !== "curator") {
    return (
      <main className="page">
        <h1>Review</h1>
        <p className="help" role="note">
          Reviewing candidates is for curators only.
        </p>
      </main>
    );
  }
  return <ReviewQueue />;
}

function ReviewQueue() {
  const [queue, setQueue] = useState<Queue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [shareWith, setShareWith] = useState("");
  const { hidden, pending, error, merged, decide, undo } = usePendingDecision();
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const listRef = useRef<HTMLOListElement>(null);
  const levels = useTeams();
  const [level, setLevel] = useState("");

  useEffect(() => {
    let live = true;
    apiFetch("/v1/review/queue?limit=100")
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return (await res.json()) as Queue;
      })
      .then((q) => live && setQueue(q))
      .catch((err: unknown) => live && setLoadError(err instanceof Error ? err.message : "Couldn't load the queue."));
    return () => {
      live = false;
    };
  }, []);

  const shown = useMemo(
    () => queue?.candidates.filter((c) => !hidden.has(c.id) && matchesLevel(c, level)) ?? [],
    [queue, hidden, level],
  );
  const flagged = useMemo(
    () => queue?.flagged.filter((f) => !hidden.has(f.id) && matchesLevel(f, level)) ?? [],
    [queue, hidden, level],
  );
  const index = Math.min(active, Math.max(shown.length - 1, 0));
  const current = shown[index];

  // A different row (moved to, or decided away) drops any half-made edit and goes back to Keep.
  useEffect(() => {
    setEditing(null);
    setShareWith("");
  }, [current?.id]);

  // On a phone the list is hidden and the card is the page, so a new card starts at its top.
  const firstCard = useRef(true);
  useEffect(() => {
    if (firstCard.current) {
      firstCard.current = false;
      return;
    }
    if (typeof matchMedia === "function" && matchMedia(SINGLE_CARD).matches) scrollTo({ top: 0 });
  }, [current?.id]);

  function move(to: number) {
    const next = Math.max(0, Math.min(to, shown.length - 1));
    setActive(next);
    if (listRef.current?.contains(document.activeElement)) rowRefs.current[next]?.focus();
  }

  /** Make a candidate the current row and focus it (from a flagged fact's "Replaced by" link). */
  function selectCandidate(id: string) {
    const i = shown.findIndex((c) => c.id === id);
    if (i < 0) return;
    setActive(i);
    rowRefs.current[i]?.focus();
  }

  function approve(c: Candidate) {
    decide({ id: c.id, via: "review", action: "approve", ...(shareWith ? { scope: shareWith } : {}) });
  }

  function submitEdit() {
    if (!current || !editing) return;
    if (editing.kind === "fix") {
      const text = editing.text.trim();
      if (text.length < 3) return;
      decide({ id: current.id, via: "review", action: "fix", new_text: text });
    } else {
      const note = editing.note.trim();
      decide({ id: current.id, via: "review", action: "reject", ...(note ? { note } : {}) });
    }
    setEditing(null);
  }

  // Latest state for the listener without re-subscribing on every render.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !current) return;
    if (e.key === "j" || e.key === "ArrowDown") move(index + 1);
    else if (e.key === "k" || e.key === "ArrowUp") move(index - 1);
    else if (e.key === "a") approve(current);
    else if (e.key === "f") setEditing({ kind: "fix", text: current.text });
    else if (e.key === "r") setEditing({ kind: "reject", note: "" });
    else return;
    e.preventDefault(); // so the f/r that opened a field isn't typed into it
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="page review-page">
      <header className="review-head">
        <h1>Review</h1>
        {queue && shown.length + flagged.length > 0 && (
          <p className="help keys">
            {shown.length + flagged.length} to review.
            {shown.length > 0 && (
              <span className="keys-hint">
                {" "}
                <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>a</kbd> approve, <kbd>f</kbd> fix, <kbd>r</kbd> reject.
              </span>
            )}
          </p>
        )}
        {queue && (queue.candidates.length > 0 || queue.flagged.length > 0) && (
          <LevelFilter id="r-level" value={level} teams={levels.teams} onChange={setLevel} />
        )}
      </header>

      {loadError && (
        <p className="error" role="alert">
          {loadError}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {merged && (
        <p className="help merged">
          Merged into{" "}
          <a
            href={`/facts/${encodeURIComponent(merged.id)}`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/facts/${encodeURIComponent(merged.id)}`);
            }}
          >
            {merged.id.slice(0, 8)}
          </a>
        </p>
      )}
      {!queue && !loadError && <p className="help">Loading…</p>}

      {queue && shown.length === 0 && flagged.length === 0 && level && (
        <p className="help">Nothing to review at this level.</p>
      )}
      {queue && shown.length === 0 && flagged.length === 0 && !level && (
        <p className="review-empty">
          Nothing to review.{" "}
          <span className="help">
            {queue.last_distill_at ? `Last distill ran ${timeAgo(queue.last_distill_at)}.` : "No distill has run yet."}
          </span>
        </p>
      )}

      {flagged.length > 0 && (
        <section className="flagged" aria-label="Corrected after citation">
          <h2>Corrected after citation</h2>
          <ul>
            {flagged.map((f) => (
              <FlaggedCard
                key={f.id}
                f={f}
                levels={levels}
                candidateLoaded={!!f.replacing && shown.some((c) => c.id === f.replacing!.id)}
                selectCandidate={selectCandidate}
                decide={decide}
              />
            ))}
          </ul>
        </section>
      )}

      {current && (
        <nav className="review-stepper" aria-label="Candidate">
          <button type="button" aria-label="Previous candidate" disabled={index === 0} onClick={() => move(index - 1)}>
            ‹
          </button>
          <span aria-live="polite">
            Candidate {index + 1} of {shown.length}
          </span>
          <button
            type="button"
            aria-label="Next candidate"
            disabled={index >= shown.length - 1}
            onClick={() => move(index + 1)}
          >
            ›
          </button>
        </nav>
      )}

      {current && (
        <div className="review-panes queue">
          <ol className="review-list" aria-label="Candidates" ref={listRef}>
            {shown.map((c, i) => (
              <li
                key={c.id}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                data-id={c.id}
                tabIndex={i === index ? 0 : -1}
                aria-current={i === index ? "true" : undefined}
                onFocus={() => setActive(i)}
                onClick={() => setActive(i)}
              >
                <span className="text">{c.text}</span>
                <span className="meta">
                  {c.kind} in <LevelBadge fact={c} {...levels} />, {c.origin}
                  {c.metadata?.asked && (
                    <>
                      {" "}
                      <span className="badge asked">asked to remember</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
          <Evidence
            key={current.id}
            c={current}
            levels={levels}
            editing={editing}
            setEditing={setEditing}
            shareWith={shareWith}
            setShareWith={setShareWith}
            submit={submitEdit}
            approve={() => approve(current)}
          />
        </div>
      )}

      {pending && (
        <div className="toast" role="status">
          <span>{DONE[pending.action]}</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={undo}>
            Undo
          </button>
        </div>
      )}
    </main>
  );
}
