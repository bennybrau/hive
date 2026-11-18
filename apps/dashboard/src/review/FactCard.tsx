import { useState, type ReactNode, type Ref } from "react";
import type { Fact } from "../facts/query";
import { LevelBadge } from "../levels/LevelBadge";
import { levelLabel, type MyTeam, type Team } from "../levels/levels";
import { WhoGetsThis } from "../levels/WhoGetsThis";
import { Badge, Button } from "../ui";
import { KIND, ORIGIN, word } from "../words";

/** Where an approve sends the fact; null keeps its level. */
export type Choice = { scope: string; label: string } | null;

/**
 * One fact to decide on, top to bottom: where it is in the queue, what it is, the proposed text (or the box editing
 * it), who gets it, why Hive thinks so, anything else (children), then the decisions (footer).
 */
export function FactCard({
  fact,
  n,
  of,
  onMove,
  levels,
  anchorRepo,
  choice,
  onChoose,
  canMove = true,
  editor,
  why,
  children,
  footer,
  ref,
}: {
  fact: Fact;
  /** 1-based position and queue length. */
  n: number;
  of: number;
  onMove: (to: number) => void;
  levels: { teams: Team[]; mine: MyTeam[] };
  anchorRepo?: string | null;
  choice: Choice;
  onChoose: (c: Choice) => void;
  /** false: no Change… (a member's own personal candidates stay at their level). */
  canMove?: boolean;
  /** Shown instead of the text while editing; the who-gets-it box is hidden then. */
  editor?: ReactNode;
  why?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  ref?: Ref<HTMLElement>;
}) {
  // The parent keys the card by fact, so a new fact starts with Change… closed.
  const [changing, setChanging] = useState(false);
  const scope = choice?.scope ?? fact.scope;
  const labelled = choice ? { scope } : fact;
  const origin = word(ORIGIN, fact.origin);
  return (
    <article className="ui-card rcard" aria-label="Fact" data-id={fact.id} tabIndex={-1} ref={ref}>
      <div className="pos">
        <span className="label" aria-live="polite">
          Fact {n} of {of}
        </span>
        <span className="row">
          <Button variant="quiet" aria-label="Previous fact" disabled={n <= 1} onClick={() => onMove(n - 2)}>
            ‹
          </Button>
          <Button variant="quiet" aria-label="Next fact" disabled={n >= of} onClick={() => onMove(n)}>
            ›
          </Button>
        </span>
      </div>
      <div className="badges">
        <Badge>{word(KIND, fact.kind).label}</Badge>
        <Badge title={origin.hint || undefined}>{origin.label}</Badge>
        {fact.metadata?.asked && <Badge tone="warn">asked to remember</Badge>}
      </div>
      {editor ?? <p className="proposed">{fact.text}</p>}
      {!editor && (
        <div className="gets">
          <LevelBadge fact={labelled} {...levels} />
          <span className="t">
            <b>Who gets it:</b> {levelLabel(labelled, levels.teams, levels.mine).hint}
          </span>
          {canMove && (
            <Button variant="quiet" className="end" aria-expanded={changing} onClick={() => setChanging(!changing)}>
              Change…
            </Button>
          )}
          {canMove && changing && (
            <WhoGetsThis
              fact={fact}
              anchorRepo={anchorRepo}
              {...levels}
              value={scope}
              onChange={(s, label) => onChoose(s === fact.scope ? null : { scope: s, label })}
            />
          )}
        </div>
      )}
      {why && (
        <section className="why" aria-label="Why Hive thinks so">
          <span className="label">Why Hive thinks so</span>
          {why}
        </section>
      )}
      {children}
      <footer className="rfoot">{footer}</footer>
    </article>
  );
}
