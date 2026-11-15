import { useState, type FormEvent, type KeyboardEvent } from "react";
import { apiFetch } from "../api";
import { levelLabel, type MyTeam, type Team } from "../levels/levels";
import { WhoGetsThis } from "../levels/WhoGetsThis";
import { Button, Field } from "../ui";
import { PHRASE } from "../words";
import type { Fact } from "./query";
import type { Me } from "./useMe";

type Editing = "fix" | "move" | "retire" | null;

/** A failed save in words: the server's `error`, or its status. */
async function failure(res: Response): Promise<string> {
  const msg = await res
    .json()
    .then((b: { error?: string }) => b.error)
    .catch(() => undefined);
  return msg || `The hive answered ${res.status}.`;
}

/**
 * Edit…, Change who gets it… and Retire, under the open fact's three plain lines. Live facts only. A curator gets all
 * three; a member gets Retire on their own Just me fact (a retract), and nothing on a shared one.
 * `onSaved` gets the fact to open next (the new wording, or the fact a move merged into), or null to reload this one.
 */
export function FactActions({
  fact,
  anchorRepo,
  teams,
  mine,
  me,
  onSaved,
}: {
  fact: Fact;
  anchorRepo: string | null;
  teams: Team[];
  mine: MyTeam[];
  me: Me;
  onSaved: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const [text, setText] = useState(fact.text);
  const [choice, setChoice] = useState<{ scope: string; label: string } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (fact.status !== "active") return null;
  const curator = me.role === "curator";
  const ownPersonal = fact.scope === `personal:${me.user_id}` && fact.author_user_id === me.user_id;
  if (!curator && !ownPersonal) return null;

  function open(kind: Exclude<Editing, null>) {
    setEditing(kind);
    setText(fact.text);
    setChoice(null);
    setReason("");
    setError(null);
  }

  function cancel() {
    setEditing(null);
    setError(null);
  }

  async function save(path: "curate" | "retract", body: object, next: (out: Record<string, unknown>) => string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/v1/facts/${encodeURIComponent(fact.id)}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await failure(res));
        return;
      }
      const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      setEditing(null);
      onSaved(next(out));
    } catch {
      setError("The hive didn't answer.");
    } finally {
      setBusy(false);
    }
  }

  const idOf = (v: unknown) => (v && typeof v === "object" && "id" in v && typeof v.id === "string" ? v.id : null);

  function submitFix(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (t.length < 3) return;
    void save("curate", { action: "fix", new_text: t }, (out) => idOf(out.new_fact));
  }

  function submitMove(e: FormEvent) {
    e.preventDefault();
    if (!choice) return;
    void save("curate", { action: "move", scope: choice.scope }, (out) => idOf(out.merged_into));
  }

  function submitRetire(e: FormEvent) {
    e.preventDefault();
    const r = reason.trim();
    if (r.length < 3) {
      setError("Say why, in a few words.");
      return;
    }
    if (curator) void save("curate", { action: "retire", note: r }, () => null);
    else void save("retract", { reason: r }, () => null);
  }

  // Esc cancels the form; preventDefault keeps the pane's own Esc-to-close from closing the fact.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const cancelButton = (
    <Button disabled={busy} onClick={cancel}>
      Cancel
    </Button>
  );

  if (editing === "fix") {
    return (
      <form className="pane-edit" onSubmit={submitFix} onKeyDown={onKey} noValidate>
        <Field label="Edit the fact" error={error}>
          {(p) => <textarea {...p} autoFocus rows={4} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <div className="pane-actions">
          <Button type="submit" variant="primary" disabled={busy || text.trim().length < 3}>
            {PHRASE.saveWording}
          </Button>
          {cancelButton}
        </div>
      </form>
    );
  }

  if (editing === "move") {
    return (
      <form className="pane-edit" onSubmit={submitMove} onKeyDown={onKey} noValidate>
        <WhoGetsThis
          fact={fact}
          anchorRepo={anchorRepo}
          teams={teams}
          mine={mine}
          allowPersonal
          value={choice?.scope ?? fact.scope}
          onChange={(scope, label) => setChoice(scope === fact.scope ? null : { scope, label })}
        />
        {error && (
          <p className="ui-error" role="alert">
            {error}
          </p>
        )}
        <div className="pane-actions">
          <Button type="submit" variant="primary" disabled={busy || !choice}>
            Move to {choice?.label ?? levelLabel(fact, teams, mine).label}
          </Button>
          {cancelButton}
        </div>
      </form>
    );
  }

  if (editing === "retire") {
    return (
      <form className="pane-edit" onSubmit={submitRetire} onKeyDown={onKey} noValidate>
        <Field label={PHRASE.retireWhy} error={error}>
          {(p) => (
            <input
              {...p}
              type="text"
              autoFocus
              required
              minLength={3}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        <div className="pane-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {PHRASE.retireThis}
          </Button>
          {cancelButton}
        </div>
      </form>
    );
  }

  return (
    <div className="pane-actions">
      {curator && (
        <>
          <Button onClick={() => open("fix")}>{PHRASE.edit}</Button>
          <Button onClick={() => open("move")}>{PHRASE.changeWho}</Button>
        </>
      )}
      <Button variant="quiet" onClick={() => open("retire")}>
        {PHRASE.retire}
      </Button>
    </div>
  );
}
