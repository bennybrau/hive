import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { apiFetch, type Role } from "../api";
import type { Fact } from "../facts/query";
import { LevelBadge } from "../levels/LevelBadge";
import { levelLabel, useTeams } from "../levels/levels";
import { WhoGetsThis } from "../levels/WhoGetsThis";
import { timeAgo } from "../review/Review";

export interface StaleFact extends Fact {
  use_count: number;
  cite_count: number;
  last_used_at: string | null;
  pinned: boolean;
  idle_days: number;
}

interface StalePage {
  facts: StaleFact[];
  has_more: boolean;
  stale_days: number;
}

export type Curate =
  | { action: "keep" | "pin" }
  | { action: "fix"; new_text: string }
  | { action: "retire"; note?: string }
  | { action: "move"; scope: string };

/** For a move: which fact, its first anchor's repo once loaded, and the chosen level (null while the current one is). */
type Editing =
  | { kind: "fix"; text: string }
  | { kind: "retire"; note: string }
  | { kind: "move"; id: string; anchorRepo: string | null; to: { scope: string; label: string } | null }
  | null;

function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** Facts nobody has used for a while, to keep, fix, retire or pin one at a time. */
export function Stale({ role }: { role: Role }) {
  if (role !== "curator") {
    return (
      <main className="page">
        <h1>Stale</h1>
        <p className="help" role="note">
          Curating stale facts is for curators only.
        </p>
      </main>
    );
  }
  return <StaleList />;
}

function StaleList() {
  const [page, setPage] = useState<StalePage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mergedInto, setMergedInto] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch("/v1/facts/stale?limit=100")
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return (await res.json()) as StalePage;
      })
      .then((p) => live && setPage(p))
      .catch((err: unknown) => live && setLoadError(err instanceof Error ? err.message : "Couldn't load stale facts."));
    return () => {
      live = false;
    };
  }, []);

  const levels = useTeams();

  const shown = page?.facts ?? [];
  const index = Math.min(active, Math.max(shown.length - 1, 0));
  const current = shown[index];

  // A different row drops any half-made edit.
  useEffect(() => setEditing(null), [current?.id]);

  async function curate(body: Curate) {
    if (!current || busy) return;
    const id = current.id;
    setBusy(true);
    setError(null);
    setMergedInto(null);
    try {
      const res = await apiFetch(`/v1/facts/${encodeURIComponent(id)}/curate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        if (body.action === "move") {
          const out = (await res.json().catch(() => ({}))) as { merged_into?: { id: string; text: string } | null };
          if (out.merged_into) setMergedInto(out.merged_into);
        }
        setPage((p) => p && { ...p, facts: p.facts.filter((f) => f.id !== id) });
        setEditing(null);
      } else {
        const msg = await res
          .json()
          .then((b: { error?: string }) => b.error)
          .catch(() => undefined);
        setError(`Couldn't save that: ${msg ? `${msg} (${res.status}).` : `the hive answered ${res.status}.`}`);
      }
    } catch {
      setError("Couldn't save that: the hive didn't answer.");
    } finally {
      setBusy(false);
    }
  }

  /** Open the move choice; the fact's first anchor repo comes from its detail. */
  function startMove() {
    if (!current) return;
    const id = current.id;
    setEditing({ kind: "move", id, anchorRepo: null, to: null });
    apiFetch(`/v1/facts/${encodeURIComponent(id)}`)
      .then(async (res) => (res.ok ? ((await res.json()) as { anchors?: { repo_key: string | null }[] }) : {}))
      .then((d) => {
        const repo = d.anchors?.[0]?.repo_key ?? null;
        if (repo) setEditing((e) => (e?.kind === "move" && e.id === id ? { ...e, anchorRepo: repo } : e));
      })
      .catch(() => {});
  }

  function submitEdit() {
    if (!editing) return;
    if (editing.kind === "move") {
      if (editing.to) void curate({ action: "move", scope: editing.to.scope });
    } else if (editing.kind === "fix") {
      const text = editing.text.trim();
      if (text.length < 3) return;
      void curate({ action: "fix", new_text: text });
    } else {
      const note = editing.note.trim();
      void curate({ action: "retire", ...(note ? { note } : {}) });
    }
  }

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitEdit();
    }
  };

  return (
    <main className="page review-page">
      <header className="review-head">
        <h1>Stale</h1>
        {page && shown.length > 0 && (
          <p className="help">
            {shown.length} unused for over {days(page.stale_days)}.
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
      {mergedInto && (
        <p className="help merged" role="status">
          Moved, merged into fact {mergedInto.id.slice(0, 8)}: {mergedInto.text}
        </p>
      )}
      {!page && !loadError && <p className="help">Loading…</p>}

      {page && shown.length === 0 && <p className="review-empty">No facts unused for {days(page.stale_days)}.</p>}

      {current && (
        <div className="review-panes">
          <ol className="review-list" aria-label="Stale facts">
            {shown.map((f, i) => (
              <li
                key={f.id}
                data-id={f.id}
                tabIndex={i === index ? 0 : -1}
                aria-current={i === index ? "true" : undefined}
                onFocus={() => setActive(i)}
                onClick={() => setActive(i)}
              >
                <span className="text">{f.text}</span>
                <span className="meta">
                  {f.kind} in <LevelBadge fact={f} {...levels} />, idle {days(f.idle_days)}
                </span>
              </li>
            ))}
          </ol>

          <aside className="review-evidence" aria-label="Fact">
            {editing?.kind === "fix" ? (
              <div className="field">
                <label htmlFor="s-fix">Fixed text</label>
                <textarea
                  id="s-fix"
                  autoFocus
                  rows={4}
                  value={editing.text}
                  disabled={busy}
                  onChange={(e) => setEditing({ kind: "fix", text: e.target.value })}
                  onKeyDown={onKey}
                />
                <p className="help">Enter saves, Esc cancels.</p>
              </div>
            ) : (
              <p className="fact-text">{current.text}</p>
            )}

            <dl>
              <dt>Kind</dt>
              <dd>{current.kind}</dd>
              <dt>Level</dt>
              <dd>
                <LevelBadge fact={current} {...levels} />
              </dd>
              <dt>Idle</dt>
              <dd>{days(current.idle_days)}</dd>
              <dt>Uses</dt>
              <dd>{current.use_count}</dd>
              <dt>Cites</dt>
              <dd>{current.cite_count}</dd>
              <dt>Last used</dt>
              <dd>{current.last_used_at ? timeAgo(current.last_used_at) : "never"}</dd>
            </dl>

            {editing?.kind === "move" ? (
              <div className="stale-confirm">
                <WhoGetsThis
                  fact={current}
                  anchorRepo={editing.anchorRepo}
                  {...levels}
                  allowPersonal
                  value={editing.to?.scope ?? current.scope}
                  onChange={(scope, label) =>
                    setEditing({ ...editing, to: scope === current.scope ? null : { scope, label } })
                  }
                />
                <div className="stale-actions">
                  <button type="button" disabled={busy || !editing.to} onClick={submitEdit}>
                    Move to {editing.to?.label ?? levelLabel(current, levels.teams, levels.mine).label}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : editing?.kind === "retire" ? (
              <div className="stale-confirm">
                <div className="field">
                  <label htmlFor="s-note">Why retire it? (optional)</label>
                  <input
                    id="s-note"
                    type="text"
                    autoFocus
                    value={editing.note}
                    disabled={busy}
                    onChange={(e) => setEditing({ kind: "retire", note: e.target.value })}
                    onKeyDown={onKey}
                  />
                </div>
                <div className="stale-actions">
                  <button type="button" className="danger" disabled={busy} onClick={submitEdit}>
                    Retire fact
                  </button>
                  <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : editing?.kind === "fix" ? (
              <div className="stale-actions">
                <button type="button" disabled={busy || editing.text.trim().length < 3} onClick={submitEdit}>
                  Save fix
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="stale-actions">
                <button type="button" disabled={busy} onClick={() => void curate({ action: "keep" })}>
                  Keep
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing({ kind: "fix", text: current.text })}>
                  Fix
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing({ kind: "retire", note: "" })}>
                  Retire
                </button>
                <button type="button" disabled={busy} onClick={() => void curate({ action: "pin" })}>
                  Pin
                </button>
                <button type="button" disabled={busy} onClick={startMove}>
                  Move…
                </button>
              </div>
            )}
          </aside>
        </div>
      )}

      {page?.has_more && <p className="help">Showing the first 100 stale facts only.</p>}
    </main>
  );
}
