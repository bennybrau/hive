import type { FastifyInstance } from "fastify";
import type pg from "pg";

/** Start of the window: midnight UTC, `days - 1` days ago (so days=1 is today, UTC). */
const SINCE = "(date_trunc('day', now() at time zone 'UTC') - ($1::int - 1) * interval '1 day') at time zone 'UTC'";
const DAY = (col: string) => `to_char((${col} at time zone 'UTC')::date, 'YYYY-MM-DD')`;

async function countBy(pool: pg.Pool, expr: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ key: string; count: number }>(
    `select ${expr} as key, count(*)::int as count from facts group by 1 order by 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.count]));
}

/** Curator overview: fact counts, LLM cost per day and job, workers and backlog. Everything aggregated in SQL. */
export function statsRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get<{ Querystring: { days: number } }>(
    "/v1/stats",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { days: { type: "integer", minimum: 1, maximum: 365, default: 30 } },
        },
      },
    },
    async (req, reply) => {
      if (req.instance!.role !== "curator") return reply.code(403).send({ error: "only a curator can see stats" });
      const days = req.query.days;
      const since = await pool.query<{ since: Date }>(`select ${SINCE} as since`, [days]);
      const by_status = await countBy(pool, "status");
      const by_origin = await countBy(pool, "origin");
      // Personal scopes fold into one bucket: no user ids in the response.
      const by_scope = await countBy(pool, "case when scope like 'personal:%' then 'personal' else scope end");
      const per_day = await pool.query(
        `select ${DAY("recorded_at")} as day, count(*)::int as count from facts
         where recorded_at >= ${SINCE} group by 1 order by 1`,
        [days],
      );
      const sums = `count(*)::int as calls, coalesce(sum(input_tokens),0)::float8 as input_tokens,
        coalesce(sum(output_tokens),0)::float8 as output_tokens, coalesce(sum(est_cost_usd),0)::float8 as cost_usd`;
      const cost = await pool.query(
        `select ${DAY("created_at")} as day, job, ${sums} from llm_calls
         where created_at >= ${SINCE} group by 1, 2 order by 1, 2`,
        [days],
      );
      const costTotals = await pool.query(
        `select job, ${sums} from llm_calls where created_at >= ${SINCE} group by 1 order by 1`,
        [days],
      );
      const workers = await pool.query<{ id: string; name: string; last_seen_at: Date | null }>(
        `select id, name, last_seen_at from instances where role = 'worker' and revoked_at is null order by name`,
      );
      const backlog = await pool.query<{
        candidates: number;
        oldest_candidate_at: Date | null;
        distill_queued: number;
        oldest_queued_at: Date | null;
      }>(
        `select (select count(*)::int from facts where status = 'candidate') as candidates,
                (select min(recorded_at) from facts where status = 'candidate') as oldest_candidate_at,
                (select count(*)::int from distill_jobs where status = 'queued') as distill_queued,
                (select min(created_at) from distill_jobs where status = 'queued') as oldest_queued_at`,
      );
      return {
        days,
        since: since.rows[0]!.since,
        facts: { by_status, by_origin, by_scope, per_day: per_day.rows },
        cost: cost.rows,
        cost_totals: costTotals.rows,
        workers: workers.rows,
        backlog: backlog.rows[0],
      };
    },
  );
}
