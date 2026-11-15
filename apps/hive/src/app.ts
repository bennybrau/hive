import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyLoggerOptions } from "fastify";
import type pg from "pg";
import { bearerAuth, confineWorker } from "./auth.js";
import { DistillNotifier } from "./distill.js";
import type { Embedder } from "./embed.js";
import type { EmbedWorker } from "./jobs/embed.js";
import { mcpRoutes } from "./mcp.js";
import { briefRoutes } from "./routes/brief.js";
import { episodeRoutes } from "./routes/episodes.js";
import { factRoutes } from "./routes/facts.js";
import { repoRoutes, type RepoDeps } from "./routes/repos.js";
import { playbookRoutes } from "./routes/playbooks.js";
import { reviewRoutes } from "./routes/review.js";
import { reviewDigestRoutes, type ReviewDigestDeps } from "./routes/review-digest.js";
import { healthRoutes } from "./routes/health.js";
import { homeRoutes } from "./routes/home.js";
import { searchRoutes } from "./routes/search.js";
import { settingsRoutes } from "./routes/settings.js";
import { statsRoutes } from "./routes/stats.js";
import { statusRoutes } from "./routes/status.js";
import { teamRoutes } from "./routes/teams.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { workerRoutes } from "./routes/worker.js";

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
  /** Longest a distill claim long-polls before answering 204 (default 25 s). */
  distillClaimWaitMs?: number;
  /** Lease on a claimed distill job (default 600 s). */
  distillLeaseSeconds?: number;
  /** Wakes waiting claims when an episode arrives; one is made when omitted. */
  distillNotifier?: DistillNotifier;
  /** Days without a use or a keep before an active, unpinned fact is stale (default 60). */
  staleDays?: number;
  /** Built dashboard to serve at /; omitted or missing = API only. */
  dashboardDir?: string;
  /** Where the review digest's Telegram messages go and how long its first retry waits (tests: a fake, short). */
  reviewDigest?: ReviewDigestDeps;
}

/** API paths keep JSON 404s; any other page load is a dashboard route. */
const API_PATH = /^\/(v1|health)(\/|\?|$)/;

export function buildApp(pool: pg.Pool, opts: AppOptions): FastifyInstance {
  // The default serializers log method/url/headers, never bodies, so a PUT credential stays out of the logs.
  const logger = opts.logger ? { ...(opts.logger === true ? {} : opts.logger), redact: ["req.headers.authorization"] } : false;
  const app = Fastify({ logger });
  const embedder = opts.embedder ?? null;
  const worker = opts.worker ?? null;
  const onWrite = () => worker?.kick();
  const notifier = opts.distillNotifier ?? new DistillNotifier();

  healthRoutes(app, pool, opts.version);
  const statusOpts = { version: opts.version, embedModel: embedder?.model ?? null, worker };
  const searchDeps = { pool, embedder, minSimilarity: opts.minSimilarity ?? 0.55 };
  // Everything under /v1 requires a bearer token.
  app.register(async (v1) => {
    v1.addHook("onRequest", bearerAuth(pool));
    v1.addHook("onRequest", confineWorker);
    statusRoutes(v1, pool, statusOpts);
    factRoutes(v1, pool, onWrite, opts.staleDays ?? 60);
    episodeRoutes(v1, pool, () => {
      onWrite();
      notifier.kick();
    });
    reviewRoutes(v1, pool, onWrite);
    playbookRoutes(v1, pool);
    teamRoutes(v1, pool);
    settingsRoutes(v1, pool, opts.secretKey ?? null);
    reviewDigestRoutes(v1, pool, opts.secretKey ?? null, opts.reviewDigest ?? {});
    statsRoutes(v1, pool);
    homeRoutes(v1, pool, opts.staleDays ?? 60);
    webhookRoutes(v1, pool, opts.secretKey ?? null);
    workerRoutes(v1, {
      pool,
      embedder,
      secretKey: opts.secretKey ?? null,
      notifier,
      claimWaitMs: opts.distillClaimWaitMs ?? 25_000,
      leaseSeconds: opts.distillLeaseSeconds ?? 600,
      onWrite,
    });
    searchRoutes(v1, searchDeps);
    briefRoutes(v1, searchDeps);
    if (opts.repos) repoRoutes(v1, pool, opts.repos);
  });
  // MCP for Claude Code and other MCP clients: the same tokens and roles; a worker token gets 403.
  app.register(async (mcp) => {
    mcp.addHook("onRequest", bearerAuth(pool));
    mcp.addHook("onRequest", confineWorker);
    mcpRoutes(mcp, { search: searchDeps, onWrite, status: statusOpts });
  });

  const dashboard = opts.dashboardDir && existsSync(opts.dashboardDir) ? opts.dashboardDir : null;
  if (dashboard) app.register(fastifyStatic, { root: dashboard, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (dashboard && (req.method === "GET" || req.method === "HEAD") && !API_PATH.test(req.url)) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 });
  });
  return app;
}
