import Fastify, { type FastifyInstance, type FastifyLoggerOptions } from "fastify";
import type pg from "pg";
import { bearerAuth, confineWorker } from "./auth.js";
import type { Embedder } from "./embed.js";
import type { EmbedWorker } from "./jobs/embed.js";
import { episodeRoutes } from "./routes/episodes.js";
import { factRoutes } from "./routes/facts.js";
import { repoRoutes, type RepoDeps } from "./routes/repos.js";
import { reviewRoutes } from "./routes/review.js";
import { healthRoutes } from "./routes/health.js";
import { searchRoutes } from "./routes/search.js";
import { settingsRoutes } from "./routes/settings.js";
import { statusRoutes } from "./routes/status.js";

export interface AppOptions {
  version: string;
  /** true, or logger options (tests pass a `stream`). Authorization headers are always redacted. */
  logger?: boolean | FastifyLoggerOptions;
  embedder?: Embedder | null;
  worker?: EmbedWorker | null;
  minSimilarity?: number;
  /** Repo registration/ingest/verify; omitted = those endpoints are not mounted. */
  repos?: RepoDeps | null;
  /** Encrypts stored secrets; null = the agent credential can't be set (503). */
  secretKey?: Buffer | null;
}

export function buildApp(pool: pg.Pool, opts: AppOptions): FastifyInstance {
  // The default serializers log method/url/headers, never bodies, so a PUT credential stays out of the logs.
  const logger = opts.logger ? { ...(opts.logger === true ? {} : opts.logger), redact: ["req.headers.authorization"] } : false;
  const app = Fastify({ logger });
  const embedder = opts.embedder ?? null;
  const worker = opts.worker ?? null;
  const onWrite = () => worker?.kick();

  healthRoutes(app, pool, opts.version);
  // Everything under /v1 requires a bearer token.
  app.register(async (v1) => {
    v1.addHook("onRequest", bearerAuth(pool));
    v1.addHook("onRequest", confineWorker);
    statusRoutes(v1, pool, { version: opts.version, embedModel: embedder?.model ?? null, worker });
    factRoutes(v1, pool, onWrite);
    episodeRoutes(v1, pool, onWrite);
    reviewRoutes(v1, pool, onWrite);
    settingsRoutes(v1, pool, opts.secretKey ?? null);
    searchRoutes(v1, { pool, embedder, minSimilarity: opts.minSimilarity ?? 0.55 });
    if (opts.repos) repoRoutes(v1, pool, opts.repos);
  });
  return app;
}
