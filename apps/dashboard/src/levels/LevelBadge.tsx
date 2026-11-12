import { levelLabel, levelOf, type Labelled, type MyTeam, type Team } from "./levels";

/** Just me / Repo: <name> / Team: <name> / Everyone, with the raw scope on hover. */
export function LevelBadge({ fact, teams, mine }: { fact: Labelled; teams?: Team[]; mine?: MyTeam[] }) {
  const l = levelOf(fact, teams, mine);
  return (
    <span className="level" title={fact.scope}>
      <span className={`badge level-${l.level}`}>{levelLabel(fact, teams, mine).label}</span>
      {l.team?.own && <span className="own-team">your team</span>}
    </span>
  );
}
