import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { apiFetch, type Role } from "../api";
import type { Fact } from "../facts/query";
import { levelLabel, useTeams } from "../levels/levels";
import { WhoGetsThis } from "../levels/WhoGetsThis";
import { FactCard, type Choice } from "../review/FactCard";
import { Button, EmptyState, Field, PageHeader } from "../ui";
import { PHRASE, when } from "../words";

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

/** What the footer is asking for; the level a move goes to is the card's choice. */
type Editing = { kind: "fix"; text: string } | { kind: "retire"; note: string } | { kind: "move" } | null;

function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** Facts nobody has used for a while, one card at a time, to keep, move, retire, edit or pin. */
export function Stale({ role }: { role: Role }) {
  if (role !== "curator") {
    return (
      <main className="page">
        <h1>Out of date</h1>
        <p className="help" role="note">
          Curating stale facts is for curators only.
        </p>
      </main>
    );
  }
  return <StaleList />;
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

/** Why the fact is here: how long nobody has used it, and when it was last used or added. */
function why(f: StaleFact, staleDays: number) {
  return f.last_used_at ? (
    <p>
      Nobody has used it in {days(staleDays)}. Last used <When iso={f.last_used_at} />.
    </p>
  ) : (
    <p>
      Never used since it was added <When iso={f.recorded_at} />.
    </p>
  );
}

function StaleList() {
  const [page, setPage] = useState<StalePage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [choice, setChoice] = useState<Choice>(null);
  const [anchor, setAnchor] = useState<{ id: string; repo: string | null } | null>(null);
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

  // A different fact drops any half-made edit and goes back to its current level.
  const [cardId, setCardId] = useState(current?.id);
  if (cardId !== current?.id) {
    setCardId(current?.id);
    setEditing(null);
    setChoice(null);
  }

  // The fact's first anchor repo, from its detail, so both Change… and Move… can offer "this repo".
  useEffect(() => {
    if (!current) return;
    const id = current.id;
    let live = true;
    apiFetch(`/v1/facts/${encodeURIComponent(id)}`)
      .then(async (res) => (res.ok ? ((await res.json()) as { anchors?: { repo_key: string | null }[] }) : {}))
      .then((d) => live && setAnchor({ id, repo: d.anchors?.[0]?.repo_key ?? null }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [current?.id]);
  const anchorRepo = anchor && anchor.id === current?.id ? anchor.repo : null;

  function move(to: number) {
    setActive(Math.max(0, Math.min(to, shown.length - 1)));
  }

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

  function cancel() {
    setEditing(null);
    setChoice(null);
  }

  function submitEdit() {
    if (!editing) return;
    if (editing.kind === "move") {
      if (choice) void curate({ action: "move", scope: choice.scope });
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

  // A level picked from Change… is a move too.
  const moving = editing?.kind === "move" || (!editing && choice !== null);

  return (
    <main className="page review-queue">
      <PageHeader
        title="Out of date"
        lede={
          page &&
          shown.length > 0 &&
          `${shown.length} ${shown.length === 1 ? "fact" : "facts"} nobody has used in ${days(page.stale_days)}.`
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
      {mergedInto && (
        <p className="help merged" role="status">
          Moved, merged into fact {mergedInto.id.slice(0, 8)}: {mergedInto.text}
        </p>
      )}
      {!page && !loadError && <p className="help">Loading…</p>}

      {page && shown.length === 0 && (
        <EmptyState title="Nothing is out of date">
          A fact shows here when no agent has used it for {days(page.stale_days)}.
        </EmptyState>
      )}

      {page && current && (
        <FactCard
          key={current.id}
          fact={current}
          n={index + 1}
          of={shown.length}
          onMove={move}
          levels={levels}
          anchorRepo={anchorRepo}
          choice={choice}
          onChoose={setChoice}
          editor={
            editing?.kind === "fix" ? (
              <Field label="Edit the fact" help="Enter saves, Shift+Enter adds a line, Esc cancels.">
                {(p) => (
                  <textarea
                    {...p}
                    autoFocus
                    rows={4}
                    value={editing.text}
                    disabled={busy}
                    onChange={(e) => setEditing({ kind: "fix", text: e.target.value })}
                    onKeyDown={onKey}
                  />
                )}
              </Field>
            ) : undefined
          }
          why={why(current, page.stale_days)}
          footer={
            <>
              {editing?.kind === "retire" && (
                <Field label="Why retire it? (optional)" help="Enter retires, Esc cancels.">
                  {(p) => (
                    <input
                      {...p}
                      type="text"
                      autoFocus
                      value={editing.note}
                      disabled={busy}
                      onChange={(e) => setEditing({ kind: "retire", note: e.target.value })}
                      onKeyDown={onKey}
                    />
                  )}
                </Field>
              )}
              {editing?.kind === "move" && (
                <WhoGetsThis
                  fact={current}
                  anchorRepo={anchorRepo}
                  {...levels}
                  allowPersonal
                  value={choice?.scope ?? current.scope}
                  onChange={(scope, label) => setChoice(scope === current.scope ? null : { scope, label })}
                />
              )}
              <div className="actions" role="group" aria-label="Decide">
                {moving ? (
                  <>
                    <Button
                      variant="primary"
                      big
                      disabled={busy || !choice}
                      onClick={() => choice && void curate({ action: "move", scope: choice.scope })}
                    >
                      Move to {choice?.label ?? levelLabel(current, levels.teams, levels.mine).label}
                    </Button>
                    <Button big disabled={busy} onClick={cancel}>
                      Cancel
                    </Button>
                  </>
                ) : editing ? (
                  <>
                    {editing.kind === "fix" ? (
                      <Button variant="primary" big disabled={busy || editing.text.trim().length < 3} onClick={submitEdit}>
                        Save fix
                      </Button>
                    ) : (
                      <Button big className="danger" disabled={busy} onClick={submitEdit}>
                        Retire fact
                      </Button>
                    )}
                    <Button big disabled={busy} onClick={cancel}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="primary" big disabled={busy} onClick={() => void curate({ action: "keep" })}>
                      Keep
                    </Button>
                    <Button big disabled={busy} onClick={() => setEditing({ kind: "move" })}>
                      Move…
                    </Button>
                    <Button big disabled={busy} onClick={() => setEditing({ kind: "retire", note: "" })}>
                      Retire
                    </Button>
                    <Button variant="quiet" disabled={busy} onClick={() => setEditing({ kind: "fix", text: current.text })}>
                      {PHRASE.edit}
                    </Button>
                    <Button variant="quiet" disabled={busy} onClick={() => void curate({ action: "pin" })}>
                      Pin
                    </Button>
                  </>
                )}
              </div>
            </>
          }
        >
          <details className="more">
            <summary>{PHRASE.provenance}</summary>
            <dl className="details">
              <dt>Uses</dt>
              <dd>{current.use_count}</dd>
              <dt>Cites</dt>
              <dd>{current.cite_count}</dd>
              <dt>Id</dt>
              <dd>
                <code>{current.id}</code>
              </dd>
            </dl>
          </details>
        </FactCard>
      )}

      {page?.has_more && <p className="help">Showing the first 100 stale facts only.</p>}
    </main>
  );
}
