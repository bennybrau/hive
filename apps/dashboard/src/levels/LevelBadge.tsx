import { levelOf, type Labelled, type Level, type MyTeam, type Team } from "./levels";

const NAMES: Record<Level, string> = { personal: "Personal", repository: "Repository", team: "Team", organisation: "Organisation" };

/** Personal / Repository / Team: <name> / Organisation, with the raw scope on hover. */
export function LevelBadge({ fact, teams, mine }: { fact: Labelled; teams?: Team[]; mine?: MyTeam[] }) {
  const l = levelOf(fact, teams, mine);
  return (
    <span className="level" title={fact.scope}>
      <span className={`badge level-${l.level}`}>{l.team ? `Team: ${l.team.name}` : NAMES[l.level]}</span>
      {l.team?.own && <span className="own-team">your team</span>}
    </span>
  );
}
