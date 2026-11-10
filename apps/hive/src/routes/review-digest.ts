import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { sendDigestChannels } from "../review-digest/channels.js";
import { getReviewDigestConfig, type ReviewDigestConfig } from "../review-digest/config.js";
import { buildDigest } from "../review-digest/content.js";

export interface ReviewDigestDeps {
  /** Telegram Bot API base URL (default https://api.telegram.org). */
  telegramApiUrl?: string;
  /** Wait before a channel's first retry (default 1 s). */
  backoffMs?: number;
}

/** Sending the review digest now, to check the channels. Records nothing: the daily digest is unaffected. */
export function reviewDigestRoutes(app: FastifyInstance, pool: pg.Pool, secretKey: Buffer | null, deps: ReviewDigestDeps): void {
  app.post("/v1/review-digest/test", async (req, reply) => {
    if (req.instance!.role !== "curator") return reply.code(403).send({ error: "only a curator can send a test digest" });
    if (!secretKey) return reply.code(503).send({ error: "HIVE_SECRET_KEY is not set" });
    let cfg: (ReviewDigestConfig & { user_id: string }) | null = null;
    try {
      cfg = await getReviewDigestConfig(pool, secretKey);
    } catch {
      // stored under another key: as good as unset
    }
    if (!cfg) return reply.code(409).send({ error: "the review digest is not configured" });
    if (!cfg.email && !cfg.telegram) return reply.code(409).send({ error: "the review digest has no channel (email or Telegram)" });

    const digest = await buildDigest(pool, {
      user_id: cfg.user_id,
      timezone: cfg.timezone,
      dashboard_url: cfg.dashboard_url,
      since: null,
      now: new Date(),
    });
    const result = await sendDigestChannels(cfg, digest, { telegramApiUrl: deps.telegramApiUrl, backoffMs: deps.backoffMs });
    for (const [channel, r] of Object.entries(result)) {
      if (r.status === "failed") req.log.warn({ channel, error: r.error }, "test review digest failed");
    }
    return result;
  });
}
