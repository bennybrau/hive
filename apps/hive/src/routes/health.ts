import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { pingDb } from "../db/pool.js";

/** Unauthenticated liveness: says nothing about the data, only whether the service and DB are up. */
export function healthRoutes(app: FastifyInstance, pool: pg.Pool, version: string): void {
  app.get("/health", async (_req, reply) => {
    const dbUp = await pingDb(pool);
    return reply.code(dbUp ? 200 : 503).send({ ok: dbUp, db: dbUp ? "up" : "down", version });
  });
}
