import type { Team } from "./levels";

/** The "Level" select; its value is what matchesLevel takes. */
export function LevelFilter({
  id,
  value,
  teams,
  onChange,
}: {
  id: string;
  value: string;
  teams: Team[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>Level</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        <option value="personal">Personal</option>
        <option value="repository">Repository</option>
        {teams.map((t) => (
          <option key={t.key} value={`team:${t.key}`}>
            Team: {t.name}
          </option>
        ))}
        <option value="global">Organisation</option>
      </select>
    </div>
  );
}
