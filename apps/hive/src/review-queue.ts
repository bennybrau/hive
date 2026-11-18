import type pg from "pg";
import type { Instance } from "./auth.js";
import { FACT_COLUMNS, type Correction, type Fact } from "./facts.js";
import { readableScopes } from "./scope.js";

export type QueueCandidate = Fact & { supersedes: string | null };
export type QueueFlagged = Fact & { correction: Correction; replacing: { id: string; text: string } | null };

export interface QueueOptions {
  scope?: string;
  origin?: string;
  /** No limit when left out. */
  limit?: number;
  /** A member's queue: only their own personal candidates, and nothing flagged. */
  ownPersonalOnly?: boolean;
}

/**
 * What waits for review: candidates (asked first, then oldest) and active facts flagged as corrected (newest flag
 * first, with the candidate that would replace each while it is still a candidate). Distilled personal facts are
 * candidates too; nobody ever sees another user's.
 */
export async function loadReviewQueueItems(
  pool: pg.Pool,
  instance: Pick<Instance, "user_id">,
  opts: QueueOptions = {},
): Promise<{ candidates: QueueCandidate[]; flagged: QueueFlagged[] }> {
  const [scopeSql, params]: [string, unknown[]] = opts.ownPersonalOnly
    ? ["scope = $1", [`personal:${instance.user_id}`]]
    : readableScopes(instance, undefined, 1);
  const where = ["status = 'candidate'", scopeSql];
  if (opts.scope) {
    params.push(opts.scope);
    where.push(`scope = $${params.length}`);
  }
  if (opts.origin) {
    params.push(opts.origin);
    where.push(`origin = $${params.length}`);
  }
  let limit = "";
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    limit = ` limit $${params.length}`;
  }
  const { rows: candidates } = await pool.query<QueueCandidate>(
    `select ${FACT_COLUMNS}, supersedes from facts where ${where.join(" and ")}
     order by (metadata->>'asked')::boolean is true desc, recorded_at, id${limit}`,
    params,
  );
  if (opts.ownPersonalOnly) return { candidates, flagged: [] };

  const [flagScopeSql, flagParams] = readableScopes(instance, undefined, 1, "f.scope");
  let flagScope = "";
  if (opts.scope) {
    flagParams.push(opts.scope);
    flagScope = ` and f.scope = $${flagParams.length}`;
  }
  let flagLimit = "";
  if (opts.limit !== undefined) {
    flagParams.push(opts.limit);
    flagLimit = ` limit $${flagParams.length}`;
  }
  const { rows: flagged } = await pool.query<QueueFlagged>(
    `select ${FACT_COLUMNS.split(", ").map((c) => `f.${c}`).join(", ")}, f.metadata->'correction' as correction,
            (select jsonb_build_object('id', c.id, 'text', c.text) from facts c
             where c.id::text = f.metadata->'correction'->>'candidate_id' and c.status = 'candidate') as replacing
     from facts f
     where f.status = 'active' and f.metadata ? 'correction' and ${flagScopeSql}${flagScope}
     order by (f.metadata->'correction'->>'at')::timestamptz desc, f.id${flagLimit}`,
    flagParams,
  );
  return { candidates, flagged };
}
