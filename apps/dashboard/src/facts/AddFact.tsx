import { useState, type FormEvent, type KeyboardEvent } from "react";
import { apiFetch } from "../api";
import { useTeams } from "../levels/levels";
import { WhoGetsThis } from "../levels/WhoGetsThis";
import { Button, Field } from "../ui";
import { KIND, PHRASE, word } from "../words";
import { KINDS, type Fact } from "./query";
import type { Me } from "./useMe";

/**
 * Add a fact, in the pane beside the list (or as its own page under 1180px): the fact, its kind and who gets it, Just me
 * by default. A curator can write into any team, a member into their own. A member's shared fact waits for review.
 * `onAdded` gets the saved fact, and whether it was already a fact (same text at that level).
 */
export function AddFact({ me, onAdded, onCancel }: { me: Me | null; onAdded: (fact: Fact, deduped: boolean) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("decision");
  const [scope, setScope] = useState("personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { teams, mine } = useTeams();
  const curator = me?.role === "curator";
  const writable = curator ? teams : teams.filter((t) => mine.some((m) => m.key === t.key));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const t = text.trim();
    if (t.length < 3) {
      setError("Write the fact, in a few words.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/v1/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, kind, scope }),
      });
      const body = (await res.json().catch(() => ({}))) as { fact?: Fact; deduped?: boolean; error?: string };
      if ((res.status === 201 || res.status === 200) && body.fact) {
        onAdded(body.fact, body.deduped === true);
        return;
      }
      setError(body.error || `The hive answered ${res.status}.`);
    } catch {
      setError("The hive didn't answer.");
    } finally {
      setBusy(false);
    }
  }

  // Esc cancels; preventDefault keeps the page's own Esc from closing it a second time.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <aside className="kn-pane" aria-label={PHRASE.addFact}>
      <form className="pane-edit add-fact" onSubmit={submit} onKeyDown={onKey} noValidate>
        <h2>{PHRASE.addFact}</h2>
        <Field label="The fact" error={error}>
          {(p) => <textarea {...p} autoFocus rows={4} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <Field label="Kind">
          {(p) => (
            <select {...p} value={kind} disabled={busy} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {word(KIND, k).label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <WhoGetsThis fresh teams={writable} mine={mine} value={scope} onChange={(s) => setScope(s)} />
        {!curator && scope !== "personal" && (
          <p className="help" role="note">
            {PHRASE.needsReview}
          </p>
        )}
        <div className="pane-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {PHRASE.addThis}
          </Button>
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </aside>
  );
}
