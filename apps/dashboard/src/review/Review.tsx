import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { apiFetch, type Role } from "../api";
import type { Fact } from "../facts/query";
import { LevelBadge } from "../levels/LevelBadge";
import { LevelFilter } from "../levels/LevelFilter";
import { levelLabel, matchesLevel, useTeams, type MyTeam, type Team } from "../levels/levels";
import { Badge, Button, EmptyState, Field, Link, PageHeader } from "../ui";
import { KIND, PHRASE, STATUS, VERIFY, WHERE, when, word } from "../words";
import { FactCard, type Choice } from "./FactCard";
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
  /** Who said it, where and when; null on anchors without an episode. */
  source: { kind: string; author: string | null; where: string; at: string } | null;
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

/** "gh/o/a src/a.ts:L10–L14" */
function place(a: Anchor): string {
  const lines = !a.line_start ? "" : a.line_end && a.line_end !== a.line_start ? `:L${a.line_start}–L${a.line_end}` : `:L${a.line_start}`;
  return `${a.repo_key ? `${a.repo_key} ` : ""}${a.path ?? ""}${lines}`;
}

/** A date as words, with the full date on hover. */
function When({ iso }: { iso: string }) {
  const w = when(iso);
  return (
    <time dateTime={iso} title={w.title}>
      {w.text}
    </time>
  );
}

/** Under a quote: "Jon, in a conversation with Hermes, 2 hours ago", or the file it is from; nothing without either. */
function By({ a }: { a: Anchor }) {
  const s = a.source;
  if (s) {
    const who = [s.author, WHERE[s.where]?.label].filter(Boolean).join(", ");
    return (
      <span className="by">
        {who && `${who[0]!.toUpperCase()}${who.slice(1)}, `}
        <When iso={s.at} />
      </span>
    );
  }
  if (a.path) {
    return (
      <span className="by">
        <code>{place(a)}</code>
      </span>
    );
  }
  return null;
}

/** What a person said that the fact was drawn from: the user turn, else the conversation snippet or the quote, else the file; null without any. */
function why(c: Candidate): ReactNode {
  const ex = c.anchors.find((a) => a.exchange);
  if (ex?.exchange) {
    return (
      <blockquote className="quote">
        {ex.exchange.user}
        <By a={ex} />
      </blockquote>
    );
  }
  const q = c.anchors.find((a) => a.episode_snippet || a.quote);
  if (q) {
    return (
      <blockquote className="quote">
        {q.episode_snippet ?? q.quote}
        <By a={q} />
      </blockquote>
    );
  }
  const p = c.anchors.find((a) => a.path);
  return p ? <code className="place">{place(p)}</code> : null;
}

/** The fact a candidate would replace. Not folded: it changes what Approve does. */
function Replaces({ old }: { old: Replaced }) {
  return (
    <section className="replaces" aria-label="Replaces">
      <h3>Replaces</h3>
      <p className="old">{old.text}</p>
      <p className="help">
        <Link to={`/facts/${encodeURIComponent(old.id)}`}>{old.id.slice(0, 8)}</Link>{" "}
        {old.status === "active"
          ? "Approve or edit retires it. Reject leaves it as it is."
          : `Already ${word(STATUS, old.status).label.toLowerCase()}. Approving won't change it.`}
      </p>
    </section>
  );
}

/** Closed until asked for: what the agent said before, similar live facts, and the record's details. */
function Folds({ c }: { c: Candidate }) {
  const said = c.anchors.find((a) => a.exchange)?.exchange?.assistant;
  // The replaced fact has its own section; don't list it again as similar.
  const similar = c.similar.filter((s) => s.id !== c.replaces?.id).slice(0, 3);
  const episodes = [...new Set(c.anchors.map((a) => a.episode_id).filter((e): e is string => !!e))];
  return (
    <>
      {said && (
        <details className="more">
          <summary>{PHRASE.agentSaid}</summary>
          <p className="said">{said}</p>
        </details>
      )}
      {similar.length > 0 && (
        <details className="more">
          <summary>Similar live facts ({similar.length})</summary>
          <ul className="similar">
            {similar.map((s) => (
              <li key={s.id}>
                <span className="pct">{Math.round(s.similarity * 100)}%</span> {s.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="more">
        <summary>{PHRASE.provenance}</summary>
        <dl className="details">
          <dt>Id</dt>
          <dd>
            <code>{c.id}</code>
          </dd>
          <dt>Recorded</dt>
          <dd>
            <When iso={c.recorded_at} />
          </dd>
          {episodes.length > 0 && (
            <>
              <dt>Conversation</dt>
              <dd>
                {episodes.map((e) => (
                  <code key={e}>{e}</code>
                ))}
              </dd>
            </>
          )}
          <dt>{PHRASE.anchors}</dt>
          <dd>
            {c.anchors.length === 0 ? (
              "Nothing recorded."
            ) : (
              <ul className="anchors">
                {c.anchors.map((a) => (
                  <li key={a.id}>
                    {a.path ? <code>{place(a)}</code> : a.episode_id ? <span>From a conversation</span> : null}{" "}
                    <Badge title={word(VERIFY, a.verify_status).hint || undefined}>{word(VERIFY, a.verify_status).label}</Badge>
                    {a.quote && <pre className="quote">{a.quote}</pre>}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </details>
    </>
  );
}

const KEYS: [string, string][] = [
  ["j / ↓", "Next fact"],
  ["k / ↑", "Previous fact"],
  ["a", "Approve"],
  ["f", "Edit"],
  ["r", "Reject"],
  ["Enter", "Save (while editing)"],
  ["Shift+Enter", "New line (while editing)"],
  ["Esc", "Cancel (while editing)"],
];

function KeysTable({ id }: { id: string }) {
  return (
    <table className="keys keys-hint" id={id} aria-label="Keyboard shortcuts">
      <tbody>
        {KEYS.map(([k, does]) => (
          <tr key={k}>
            <th scope="row">
              <kbd>{k}</kbd>
            </th>
            <td>{does}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
        {word(KIND, f.kind).label} in <LevelBadge fact={f} {...levels} />. Corrected <When iso={f.correction.at} />.
      </p>
      <blockquote className="quote">{f.correction.text}</blockquote>
      {replacing && (
        <p className="help">
          Replaced by a new fact:{" "}
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

/** Must match the breakpoint in review.css where the card's footer is pinned to the bottom of the screen. */
const SINGLE_CARD = "(max-width: 900px)";

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

/** The review queue: one fact at a time, oldest first, decided from the keyboard or the card's buttons. */
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
  const [choice, setChoice] = useState<Choice>(null);
  const [keysOpen, setKeysOpen] = useState(false);
  const keysId = useId();
  const { hidden, pending, error, merged, decide, undo } = usePendingDecision();
  const cardRef = useRef<HTMLElement>(null);
  const focusCard = useRef(false);
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

  // A different fact (moved to, or decided away) drops any half-made edit and goes back to its current level.
  // Done while rendering, not in an effect, so a key pressed just after the first card shows isn't undone.
  const [cardId, setCardId] = useState(current?.id);
  if (cardId !== current?.id) {
    setCardId(current?.id);
    setEditing(null);
    setChoice(null);
  }

  // On a phone the card is the page, so a new card starts at its top.
  const firstCard = useRef(true);
  useEffect(() => {
    if (firstCard.current) {
      firstCard.current = false;
      return;
    }
    if (typeof matchMedia === "function" && matchMedia(SINGLE_CARD).matches) scrollTo({ top: 0 });
  }, [current?.id]);

  // After a flagged fact's "Replaced by" link: the card is keyed by fact, so focus the new one once it is there.
  useEffect(() => {
    if (!focusCard.current) return;
    focusCard.current = false;
    cardRef.current?.focus();
  });

  function move(to: number) {
    setActive(Math.max(0, Math.min(to, shown.length - 1)));
  }

  /** Make a candidate the current card and focus it (from a flagged fact's "Replaced by" link). */
  function selectCandidate(id: string) {
    const i = shown.findIndex((c) => c.id === id);
    if (i < 0) return;
    if (i === index) cardRef.current?.focus();
    else {
      focusCard.current = true;
      setActive(i);
    }
  }

  function approve(c: Candidate) {
    decide({ id: c.id, via: "review", action: "approve", ...(choice ? { scope: choice.scope } : {}) });
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

  const onFieldKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitEdit();
    }
  };

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

  const empty = queue && shown.length === 0 && flagged.length === 0;

  return (
    <main className="page review-queue">
      <PageHeader
        title="Review"
        lede="Hive proposes facts from what people say. Nothing reaches an agent until a curator approves it."
        action={
          queue &&
          (queue.candidates.length > 0 || queue.flagged.length > 0) && (
            <LevelFilter id="r-level" value={level} teams={levels.teams} onChange={setLevel} />
          )
        }
      />

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
          Merged into <Link to={`/facts/${encodeURIComponent(merged.id)}`}>{merged.id.slice(0, 8)}</Link>
        </p>
      )}
      {!queue && !loadError && <p className="help">Loading…</p>}

      {empty && level && <p className="help">Nothing to review at this level.</p>}
      {empty && !level && (
        <EmptyState title="Nothing waiting for review">
          {queue.last_distill_at ? (
            <>
              Hive last learned from conversations <When iso={queue.last_distill_at} />.
            </>
          ) : (
            "Hive hasn't learned from any conversations yet."
          )}
        </EmptyState>
      )}

      {current && (
        <FactCard
          key={current.id}
          ref={cardRef}
          fact={current}
          n={index + 1}
          of={shown.length}
          onMove={move}
          levels={levels}
          anchorRepo={current.anchors[0]?.repo_key}
          choice={choice}
          onChoose={setChoice}
          editor={
            editing?.kind === "fix" ? (
              <Field label="Edit the fact" help="Enter saves and approves, Shift+Enter adds a line, Esc cancels.">
                {(p) => (
                  <textarea
                    {...p}
                    autoFocus
                    rows={4}
                    value={editing.text}
                    onChange={(e) => setEditing({ kind: "fix", text: e.target.value })}
                    onKeyDown={onFieldKey}
                  />
                )}
              </Field>
            ) : undefined
          }
          why={why(current)}
          footer={
            <>
              {editing?.kind === "reject" && (
                <Field label="Why reject it? (optional)" help="Enter rejects, Esc cancels.">
                  {(p) => (
                    <input
                      {...p}
                      type="text"
                      autoFocus
                      value={editing.note}
                      onChange={(e) => setEditing({ kind: "reject", note: e.target.value })}
                      onKeyDown={onFieldKey}
                    />
                  )}
                </Field>
              )}
              <div className="actions" role="group" aria-label="Decide">
                {editing ? (
                  <>
                    {editing.kind === "fix" ? (
                      <Button variant="primary" big disabled={editing.text.trim().length < 3} onClick={submitEdit}>
                        Save and approve
                      </Button>
                    ) : (
                      <Button big className="danger" onClick={submitEdit}>
                        Reject
                      </Button>
                    )}
                    <Button big onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="primary" big onClick={() => approve(current)}>
                      Approve for {choice?.label ?? levelLabel(current, levels.teams, levels.mine).label}
                    </Button>
                    <Button big onClick={() => setEditing({ kind: "fix", text: current.text })}>
                      {PHRASE.edit}
                    </Button>
                    <Button big onClick={() => setEditing({ kind: "reject", note: "" })}>
                      Reject
                    </Button>
                    <Button
                      variant="quiet"
                      className="end keys-hint"
                      aria-expanded={keysOpen}
                      aria-controls={keysOpen ? keysId : undefined}
                      onClick={() => setKeysOpen(!keysOpen)}
                    >
                      <kbd>?</kbd> keys
                    </Button>
                  </>
                )}
              </div>
            </>
          }
        >
          {current.replaces && <Replaces old={current.replaces} />}
          <Folds c={current} />
          {keysOpen && <KeysTable id={keysId} />}
        </FactCard>
      )}

      {flagged.length > 0 && (
        <section className="flagged" aria-labelledby="r-flagged">
          <h2 id="r-flagged">Corrected after citation</h2>
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
