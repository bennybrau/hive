import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { bearerAuth } from "./auth.js";
import { healthRoutes } from "./routes/health.js";
import { statusRoutes } from "./routes/status.js";

export function buildApp(pool: pg.Pool, opts: { version: string; logger?: boolean } ): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  healthRoutes(app, pool, opts.version);
  // Everything under /v1 requires a bearer token.
  app.register(async (v1) => {
    v1.addHook("onRequest", bearerAuth(pool));
    statusRoutes(v1, pool, opts.version);
  });
  return app;
}
