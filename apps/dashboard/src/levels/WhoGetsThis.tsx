import { useEffect, useId, useState } from "react";
import { apiFetch } from "../api";
import { levelLabel, type Labelled, type MyTeam, type Team } from "./levels";

interface Option {
  scope: string;
  label: string;
  hint: string;
}

/** Every repo key the hive knows; empty if the call fails. */
function useRepoKeys(): string[] {
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    apiFetch("/v1/repo-keys")
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return ((await res.json()) as { repo_keys?: string[] }).repo_keys ?? [];
      })
      .then((k) => live && setKeys(k))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return keys;
}

/**
 * "Who should get this?": the fact's current level first, then its anchor repo, another repo, the teams, Everyone and
 * (with allowPersonal) Just me. `value` is the chosen scope; the fact's own scope means no change.
 */
export function WhoGetsThis({
  fact,
  anchorRepo,
  teams,
  mine,
  allowPersonal = false,
  value,
  onChange,
}: {
  fact: Labelled;
  anchorRepo?: string | null;
  teams: Team[];
  mine: MyTeam[];
  allowPersonal?: boolean;
  value: string;
  onChange: (scope: string, label: string) => void;
}) {
  const id = useId();
  const keys = useRepoKeys();
  const label = (scope: string) => levelLabel({ scope }, teams, mine);
  const anchorScope = anchorRepo ? `repo:${anchorRepo}` : null;
  const others = keys.filter((k) => `repo:${k}` !== fact.scope && `repo:${k}` !== anchorScope);
  const [other, setOther] = useState("");
  const otherKey = others.includes(other) ? other : (others[0] ?? "");
  const otherChosen = value.startsWith("repo:") && value !== fact.scope && value !== anchorScope;

  const current = levelLabel(fact, teams, mine);
  const before: Option[] = [{ scope: fact.scope, label: `${current.label} (current)`, hint: current.hint }];
  if (anchorScope && anchorScope !== fact.scope) before.push({ scope: anchorScope, ...label(anchorScope) });
  const after: Option[] = [...teams.map((t) => `team:${t.key}`), "global"]
    .filter((s) => s !== fact.scope)
    .map((s) => ({ scope: s, ...label(s) }));
  if (allowPersonal && !fact.scope.startsWith("personal:")) after.push({ scope: "personal", ...label("personal:") });

  const radio = (o: Option, i: string) => (
    <div className="who-option" key={o.scope}>
      <input
        type="radio"
        id={`${id}-${i}`}
        name={id}
        checked={value === o.scope}
        aria-describedby={`${id}-${i}-hint`}
        onChange={() => onChange(o.scope, o.scope === fact.scope ? current.label : o.label)}
      />
      <label htmlFor={`${id}-${i}`} title={o.scope}>
        {o.label}
      </label>
      <span id={`${id}-${i}-hint`} className="hint">
        {o.hint}
      </span>
    </div>
  );
  const pickOther = (key: string) => {
    setOther(key);
    onChange(`repo:${key}`, label(`repo:${key}`).label);
  };

  return (
    <fieldset className="who-gets-this">
      <legend>Who should get this?</legend>
      {before.map((o, i) => radio(o, `b${i}`))}
      <div className="who-option">
        <input
          type="radio"
          id={`${id}-other`}
          name={id}
          checked={otherChosen}
          disabled={others.length === 0}
          aria-describedby={`${id}-other-hint`}
          onChange={() => pickOther(otherKey)}
        />
        <label htmlFor={`${id}-other`}>Another repo…</label>
        <select
          aria-label="Another repo"
          value={otherKey}
          disabled={others.length === 0}
          title={otherKey ? `repo:${otherKey}` : undefined}
          onChange={(e) => pickOther(e.target.value)}
        >
          {others.map((k) => (
            <option key={k} value={k} title={`repo:${k}`}>
              {k}
            </option>
          ))}
        </select>
        <span id={`${id}-other-hint`} className="hint">
          {label("repo:").hint}
        </span>
      </div>
      {after.map((o, i) => radio(o, `a${i}`))}
      <p className="help">Everyone is for what holds in every repository and for every team; otherwise pick the narrowest level that fits.</p>
    </fieldset>
  );
}
