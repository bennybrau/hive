import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "../api";
import { createPlaybook, updatePlaybook, type Playbook, type PlaybookItem } from "./api";

/** An item being edited; `key` keeps React's rows stable while they move. */
interface Draft {
  key: number;
  text: string;
  facts: string;
}

/** Comma or line separated, blanks dropped. */
export function splitList(s: string): string[] {
  return s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function ItemList({
  noun,
  items,
  onChange,
  nextKey,
}: {
  noun: "step" | "pitfall";
  items: Draft[];
  onChange: (items: Draft[]) => void;
  nextKey: () => number;
}) {
  const Noun = noun === "step" ? "Step" : "Pitfall";
  const set = (i: number, patch: Partial<Draft>) => onChange(items.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, to: number) => {
    const next = [...items];
    const [d] = next.splice(i, 1);
    next.splice(to, 0, d!);
    onChange(next);
  };
  return (
    <fieldset className="playbook-items">
      <legend>{Noun}s</legend>
      {items.length === 0 && <p className="help">None yet.</p>}
      <ol>
        {items.map((d, i) => (
          <li key={d.key}>
            <div className="field">
              <label htmlFor={`pb-${noun}-${d.key}`}>
                {Noun} {i + 1}
              </label>
              <textarea
                id={`pb-${noun}-${d.key}`}
                rows={2}
                maxLength={1000}
                value={d.text}
                onChange={(e) => set(i, { text: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`pb-${noun}-${d.key}-facts`}>
                {Noun} {i + 1} fact ids
              </label>
              <input
                id={`pb-${noun}-${d.key}-facts`}
                type="text"
                placeholder="optional, comma separated"
                value={d.facts}
                onChange={(e) => set(i, { facts: e.target.value })}
              />
            </div>
            <span className="playbook-item-actions">
              <button type="button" aria-label={`Move ${noun} ${i + 1} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${noun} ${i + 1} down`}
                disabled={i === items.length - 1}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
              <button type="button" aria-label={`Remove ${noun} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>
      <button type="button" onClick={() => onChange([...items, { key: nextKey(), text: "", facts: "" }])}>
        Add {noun}
      </button>
    </fieldset>
  );
}

const toItems = (drafts: Draft[]): PlaybookItem[] =>
  drafts
    .filter((d) => d.text.trim())
    .map((d) => ({ text: d.text.trim(), fact_ids: d.facts.split(/[\s,]+/).filter(Boolean) }));

/** Create a playbook, or edit one (which saves a new version). Calls `onSaved` with what the hive stored. */
export function PlaybookForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: Playbook;
  onSaved: (p: Playbook) => void;
  onCancel: () => void;
}) {
  const keyRef = useRef(0);
  const nextKey = () => ++keyRef.current;
  const drafts = (items: PlaybookItem[] | undefined): Draft[] =>
    (items ?? []).map((i) => ({ key: nextKey(), text: i.text, facts: i.fact_ids.join(", ") }));

  const [title, setTitle] = useState(initial?.title ?? "");
  const [scopeKind, setScopeKind] = useState<"global" | "repo">(initial?.scope.startsWith("repo:") ? "repo" : "global");
  const [repo, setRepo] = useState(initial?.scope.startsWith("repo:") ? initial.scope.slice(5) : "");
  const [paths, setPaths] = useState(initial?.applies_paths.join("\n") ?? "");
  const [words, setWords] = useState(initial?.applies_words.join(", ") ?? "");
  const [steps, setSteps] = useState<Draft[]>(() => drafts(initial?.steps));
  const [pitfalls, setPitfalls] = useState<Draft[]>(() => drafts(initial?.pitfalls));
  const [repos, setRepos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiFetch("/v1/repos")
      .then(async (res) => (res.ok ? ((await res.json()) as { repos: { key: string }[] }).repos.map((r) => r.key) : []))
      .then((keys) => live && setRepos(keys))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (scopeKind === "repo" && !repo.trim()) {
      setError("Pick a repo for a repo playbook.");
      return;
    }
    const input = {
      scope: scopeKind === "global" ? "global" : `repo:${repo.trim()}`,
      title: title.trim(),
      applies_paths: splitList(paths),
      applies_words: splitList(words),
      steps: toItems(steps),
      pitfalls: toItems(pitfalls),
    };
    setSaving(true);
    setError(null);
    try {
      onSaved(initial ? await updatePlaybook(initial.id, input) : await createPlaybook(input));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the playbook.");
      setSaving(false);
    }
  }

  return (
    <form className="playbook-form" onSubmit={submit} aria-label={initial ? "Edit playbook" : "New playbook"}>
      <div className="field">
        <label htmlFor="pb-title">Title</label>
        <input id="pb-title" type="text" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="playbook-scope">
        <div className="field">
          <label htmlFor="pb-scope">Scope</label>
          <select id="pb-scope" value={scopeKind} onChange={(e) => setScopeKind(e.target.value as "global" | "repo")}>
            <option value="global">global</option>
            <option value="repo">repo</option>
          </select>
        </div>
        {scopeKind === "repo" && (
          <div className="field">
            <label htmlFor="pb-repo">Repo</label>
            <input id="pb-repo" type="text" list="pb-repos" value={repo} onChange={(e) => setRepo(e.target.value)} />
            <datalist id="pb-repos">
              {repos.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor="pb-paths">Path globs</label>
        <textarea id="pb-paths" rows={2} value={paths} onChange={(e) => setPaths(e.target.value)} />
        <p className="help">
          Comma or line separated. <code>**</code> any folders, <code>*</code> any characters but <code>/</code>.
        </p>
      </div>
      <div className="field">
        <label htmlFor="pb-words">Task words</label>
        <textarea id="pb-words" rows={2} value={words} onChange={(e) => setWords(e.target.value)} />
        <p className="help">Comma or line separated. Matched as whole words in the task, any case.</p>
      </div>
      <ItemList noun="step" items={steps} onChange={setSteps} nextKey={nextKey} />
      <ItemList noun="pitfall" items={pitfalls} onChange={setPitfalls} nextKey={nextKey} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <span className="playbook-actions">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : initial ? "Save new version" : "Create playbook"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}
