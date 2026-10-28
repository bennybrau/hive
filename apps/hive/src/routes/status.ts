import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { EmbedWorker } from "../jobs/embed.js";

/** Authenticated: who you are, coarse counts, and whether meaning search is working. */
export function statusRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  opts: { version: string; embedModel: string | null; worker: EmbedWorker | null },
): void {
  app.get("/v1/status", async (req) => {
    const { rows } = await pool.query<Record<string, string>>(
      `select (select count(*) from facts)     as facts,
              (select count(*) from episodes)  as episodes,
              (select count(*) from instances where revoked_at is null) as instances,
              (select count(*) from repos)     as repos,
              (select count(*) from facts where embedding is null)
                + (select count(*) from episodes where embedding is null)
                + (select count(*) from doc_chunks where embedding is null) as unembedded`,
    );
    const c = rows[0]!;
    const embedError = opts.worker?.lastError() ?? null;
    return {
      ok: true,
      version: opts.version,
      db: "up",
      instance: req.instance,
      counts: {
        facts: Number(c.facts),
        episodes: Number(c.episodes),
        instances: Number(c.instances),
        repos: Number(c.repos),
      },
      embeddings: {
        model: opts.embedModel,
        state: !opts.embedModel ? "off" : embedError ? "error" : "ok",
        error: embedError,
        backlog: Number(c.unembedded),
      },
    };
  });
}
