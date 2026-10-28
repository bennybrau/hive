import type { FastifyInstance } from "fastify";
import type pg from "pg";

/** Authenticated: who you are, and coarse counts. The Hermes plugin's hive_status tool calls this. */
export function statusRoutes(app: FastifyInstance, pool: pg.Pool, version: string): void {
  app.get("/v1/status", async (req) => {
    const { rows } = await pool.query<{ facts: string; episodes: string; instances: string; repos: string }>(
      `select (select count(*) from facts)     as facts,
              (select count(*) from episodes)  as episodes,
              (select count(*) from instances where revoked_at is null) as instances,
              (select count(*) from repos)     as repos`,
    );
    const c = rows[0]!;
    return {
      ok: true,
      version,
      db: "up",
      instance: req.instance,
      counts: {
        facts: Number(c.facts),
        episodes: Number(c.episodes),
        instances: Number(c.instances),
        repos: Number(c.repos),
      },
    };
  });
}
