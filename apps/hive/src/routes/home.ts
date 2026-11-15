import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { staleSql, type Fact } from "../facts.js";
import { readableScopes } from "../scope.js";
import { labelFor, teamsOf } from "../teams.js";
import { listColumns } from "./facts.js";

/** Start of this month, UTC. */
const MONTH = "(date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')";

/**
 * The dashboard's Home in one call: live facts by level, the three newest, repos and teams for everyone;
 * what waits for review, what looks out of date and this month's learning cost for a curator only.
 * Fact counts see what the caller can read: someone else's personal facts are in none of them.
 */
export function homeRoutes(app: FastifyInstance, pool: pg.Pool, staleDays: number): void {
  app.get("/v1/home", async (req) => {
    const who = req.instance!;
    const curator = who.role === "curator";
    const [scopeSql, params] = readableScopes(who, undefined, 1);
    const [levels, recent, repos, teams, review, month] = await Promise.all([
      pool.query<{ scope: string; count: number }>(
        `select case when scope = $1 then 'personal' else scope end as scope, count(*)::int as count
         from facts where status = 'active' and ${scopeSql} group by 1 order by 2 desc, 1`,
        params,
      ),
      pool.query<Fact>(
        `select ${listColumns(staleDays)} from facts where status = 'active' and ${scopeSql}
         order by recorded_at desc, id desc limit 3`,
        params,
      ),
      pool.query<{ count: number; last_read_at: Date | null; problems: number }>(
        `select count(*)::int as count, max(last_ingested_at) as last_read_at,
                count(*) filter (where ingest_error is not null)::int as problems
         from repos`,
      ),
      curator
        ? pool.query<{ count: number }>("select count(*)::int as count from teams").then((r) => r.rows[0]!.count)
        : teamsOf(pool, who.user_id).then((t) => t.length),
      curator
        ? pool.query<{ waiting: number; waiting_latest_at: Date | null; out_of_date: number; proposed: number }>(
            `select count(*) filter (where status = 'candidate')::int as waiting,
                    max(recorded_at) filter (where status = 'candidate') as waiting_latest_at,
                    count(*) filter (where ${staleSql(staleDays)})::int as out_of_date,
                    count(*) filter (where origin = 'distilled' and recorded_at >= ${MONTH})::int as proposed
             from facts where ${scopeSql}`,
            params,
          )
        : null,
      curator
        ? pool.query<{ cost_usd: number; conversations: number }>(
            `select coalesce(sum(est_cost_usd), 0)::float8 as cost_usd,
                    count(distinct episode_id) filter (where job = 'distill')::int as conversations
             from llm_calls where created_at >= ${MONTH}`,
          )
        : null,
    ]);
    const by_level = levels.rows;
    const facts = { live: by_level.reduce((sum, l) => sum + l.count, 0), by_level };
    const base = {
      facts,
      recent: await labelFor(pool, who, undefined, recent.rows),
      repos: repos.rows[0]!,
      teams: { count: teams },
    };
    if (!review || !month) return base;
    const { proposed, ...needs } = review.rows[0]!;
    return { ...base, ...needs, stale_days: staleDays, month: { ...month.rows[0]!, proposed } };
  });
}
