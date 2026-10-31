import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { bearerAuth } from "./auth.js";
import type { Embedder } from "./embed.js";
import type { EmbedWorker } from "./jobs/embed.js";
import { episodeRoutes } from "./routes/episodes.js";
import { factRoutes } from "./routes/facts.js";
import { repoRoutes, type RepoDeps } from "./routes/repos.js";
import { reviewRoutes } from "./routes/review.js";
import { healthRoutes } from "./routes/health.js";
import { searchRoutes } from "./routes/search.js";
import { statusRoutes } from "./routes/status.js";

export interface AppOptions {
  version: string;
  logger?: boolean;
  embedder?: Embedder | null;
  worker?: EmbedWorker | null;
  minSimilarity?: number;
  /** Repo registration/ingest/verify; omitted = those endpoints are not mounted. */
  repos?: RepoDeps | null;
}

export function buildApp(pool: pg.Pool, opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const embedder = opts.embedder ?? null;
  const worker = opts.worker ?? null;
  const onWrite = () => worker?.kick();

  healthRoutes(app, pool, opts.version);
  // Everything under /v1 requires a bearer token.
  app.register(async (v1) => {
    v1.addHook("onRequest", bearerAuth(pool));
    statusRoutes(v1, pool, { version: opts.version, embedModel: embedder?.model ?? null, worker });
    factRoutes(v1, pool, onWrite);
    episodeRoutes(v1, pool, onWrite);
    reviewRoutes(v1, pool, onWrite);
    searchRoutes(v1, { pool, embedder, minSimilarity: opts.minSimilarity ?? 0.55 });
    if (opts.repos) repoRoutes(v1, pool, opts.repos);
  });
  return app;
}
