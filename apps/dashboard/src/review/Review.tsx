import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { apiFetch, type Role } from "../api";
import type { Fact } from "../facts/query";
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
}

interface Similar {
  id: string;
  text: string;
  scope: string;
  similarity: number;
}

export interface Candidate extends Fact {
  supersedes: string | null;
  anchors: Anchor[];
  similar: Similar[];
}

interface Queue {
  candidates: Candidate[];
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

const DONE: Record<Decision["action"], string> = { approve: "Approved", fix: "Fixed", reject: "Rejected" };

type Editing = { kind: "fix"; text: string } | { kind: "reject"; note: string } | null;

function Evidence({
  c,
  editing,
  setEditing,
  submit,
}: {
  c: Candidate;
  editing: Editing;
  setEditing: (e: Editing) => void;
  submit: () => void;
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
  return (
    <aside className="review-evidence" aria-label="Evidence">
      {c.metadata?.asked && <span className="badge asked">asked to remember</span>}
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
          <p className="help">Enter saves, Esc cancels.</p>
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
          <p className="help">Enter rejects, Esc cancels.</p>
        </div>
      )}

      <dl>
        <dt>Kind</dt>
        <dd>{c.kind}</dd>
        <dt>Scope</dt>
        <dd>{c.scope}</dd>
        <dt>Origin</dt>
        <dd>{c.origin}</dd>
      </dl>

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
              {a.episode_snippet && <pre className="quote snippet">{a.episode_snippet}</pre>}
            </li>
          ))}
        </ul>
      )}

      {c.similar.length > 0 && (
        <>
          <h3>Similar active facts</h3>
          <ul className="similar">
            {c.similar.slice(0, 3).map((s) => (
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
  const { hidden, pending, error, decide, undo } = usePendingDecision();
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const listRef = useRef<HTMLOListElement>(null);

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

  const shown = useMemo(() => queue?.candidates.filter((c) => !hidden.has(c.id)) ?? [], [queue, hidden]);
  const index = Math.min(active, Math.max(shown.length - 1, 0));
  const current = shown[index];

  // A different row (moved to, or decided away) drops any half-made edit.
  useEffect(() => setEditing(null), [current?.id]);

  function move(to: number) {
    const next = Math.max(0, Math.min(to, shown.length - 1));
    setActive(next);
    if (listRef.current?.contains(document.activeElement)) rowRefs.current[next]?.focus();
  }

  function submitEdit() {
    if (!current || !editing) return;
    if (editing.kind === "fix") {
      const text = editing.text.trim();
      if (text.length < 3) return;
      decide({ id: current.id, action: "fix", new_text: text });
    } else {
      const note = editing.note.trim();
      decide({ id: current.id, action: "reject", ...(note ? { note } : {}) });
    }
    setEditing(null);
  }

  // Latest state for the listener without re-subscribing on every render.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  onKeyRef.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !current) return;
    if (e.key === "j" || e.key === "ArrowDown") move(index + 1);
    else if (e.key === "k" || e.key === "ArrowUp") move(index - 1);
    else if (e.key === "a") decide({ id: current.id, action: "approve" });
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
        {queue && shown.length > 0 && (
          <p className="help keys">
            {shown.length} to review. <kbd>j</kbd>/<kbd>k</kbd> move, <kbd>a</kbd> approve, <kbd>f</kbd> fix,{" "}
            <kbd>r</kbd> reject.
          </p>
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
      {!queue && !loadError && <p className="help">Loading…</p>}

      {queue && shown.length === 0 && (
        <p className="review-empty">
          Nothing to review.{" "}
          <span className="help">
            {queue.last_distill_at ? `Last distill ran ${timeAgo(queue.last_distill_at)}.` : "No distill has run yet."}
          </span>
        </p>
      )}

      {current && (
        <div className="review-panes">
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
                  {c.kind} in {c.scope}, {c.origin}
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
          <Evidence c={current} editing={editing} setEditing={setEditing} submit={submitEdit} />
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
