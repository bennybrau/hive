import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  getReviewDigestConfig,
  saveReviewDigestConfig,
  validateReviewDigest,
  type ReviewDigestConfig,
  type ReviewDigestInput,
} from "../review-digest/config.js";
import { decryptSecret, encryptSecret } from "../secrets.js";

const AGENT_CREDENTIAL = "agent_credential";

/** The fact agent's credential (e.g. a `claude setup-token` OAuth token), decrypted; null when not set. */
export async function getAgentCredential(pool: pg.Pool, key: Buffer): Promise<string | null> {
  const { rows } = await pool.query<{ value_enc: Buffer }>("select value_enc from settings where key = $1", [AGENT_CREDENTIAL]);
  return rows[0] ? decryptSecret(rows[0].value_enc, key) : null;
}

const str = (max: number) => ({ type: "string", minLength: 1, maxLength: max });
const REVIEW_DIGEST_BODY = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "dashboard_url"],
  properties: {
    enabled: { type: "boolean" },
    time: { type: "string" },
    timezone: str(100),
    dashboard_url: str(2048),
    email: {
      type: "object",
      additionalProperties: false,
      required: ["smtp_host", "smtp_port", "smtp_secure", "smtp_user", "from", "to"],
      properties: {
        smtp_host: str(255),
        smtp_port: { type: "integer", minimum: 1, maximum: 65535 },
        smtp_secure: { type: "boolean" },
        smtp_user: str(255),
        smtp_pass: str(4096),
        from: str(320),
        to: { type: "array", minItems: 1, maxItems: 10, items: str(320) },
      },
    },
    telegram: {
      type: "object",
      additionalProperties: false,
      required: ["chat_id"],
      properties: { bot_token: str(4096), chat_id: str(100) },
    },
  },
};

/** The first property REVIEW_DIGEST_BODY doesn't allow (e.g. `email.foo`), or null. */
function unknownProperty(body: unknown, schema: { properties?: Record<string, object> } = REVIEW_DIGEST_BODY, path = ""): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body) || !schema.properties) return null;
  for (const [k, v] of Object.entries(body)) {
    const sub = schema.properties[k];
    if (!sub) return path + k;
    const found = unknownProperty(v, sub, `${path}${k}.`);
    if (found) return found;
  }
  return null;
}

/** What GET shows of the review digest: no secrets, plus how the latest digest went. */
async function reviewDigestView(pool: pg.Pool, key: Buffer) {
  let cfg: ReviewDigestConfig | null;
  try {
    cfg = await getReviewDigestConfig(pool, key);
  } catch {
    return null; // stored under another key: as good as unset
  }
  if (!cfg) return null;
  const { rows } = await pool.query<{ sent_at: Date | null; item_count: number; email_error: string | null; telegram_error: string | null }>(
    "select sent_at, item_count, email_error, telegram_error from review_digests order by claimed_at desc limit 1",
  );
  const last = rows[0];
  const errors = [last?.email_error && `email: ${last.email_error}`, last?.telegram_error && `telegram: ${last.telegram_error}`].filter(Boolean);
  return {
    enabled: cfg.enabled,
    time: cfg.time,
    timezone: cfg.timezone,
    dashboard_url: cfg.dashboard_url,
    channels: {
      email: cfg.email ? { to: cfg.email.to, from: cfg.email.from } : null,
      telegram: cfg.telegram ? { chat_id: cfg.telegram.chat_id } : null,
    },
    last_sent_at: last?.sent_at?.toISOString() ?? null,
    last_item_count: last?.item_count ?? null,
    last_error: errors.length ? errors.join("; ") : null,
  };
}

/** Service settings. Values are stored encrypted and never returned; GET only says whether each is set. */
export function settingsRoutes(app: FastifyInstance, pool: pg.Pool, secretKey: Buffer | null): void {
  app.put<{ Body: { credential: string } }>(
    "/v1/settings/agent-credential",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["credential"],
          properties: { credential: { type: "string", minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (req, reply) => {
      if (req.instance!.role !== "curator") return reply.code(403).send({ error: "only a curator can change settings" });
      if (!secretKey) return reply.code(503).send({ error: "HIVE_SECRET_KEY is not set" });
      await pool.query(
        `insert into settings (key, value_enc, set_by_user_id) values ($1, $2, $3)
         on conflict (key) do update set value_enc = excluded.value_enc, set_at = now(), set_by_user_id = excluded.set_by_user_id`,
        [AGENT_CREDENTIAL, encryptSecret(req.body.credential, secretKey), req.instance!.user_id],
      );
      return reply.code(204).send();
    },
  );

  app.put<{ Body: ReviewDigestInput }>(
    "/v1/settings/review-digest",
    {
      schema: { body: REVIEW_DIGEST_BODY },
      // Runs before the schema check, which would otherwise answer a member with 400 and silently drop
      // unknown properties (Fastify's Ajv has removeAdditional on) instead of rejecting them.
      preValidation: async (req, reply) => {
        if (req.instance!.role !== "curator") return reply.code(403).send({ error: "only a curator can change settings" });
        if (!secretKey) return reply.code(503).send({ error: "HIVE_SECRET_KEY is not set" });
        const unknown = unknownProperty(req.body);
        if (unknown) return reply.code(400).send({ error: `body has unknown property ${unknown}` });
      },
    },
    async (req, reply) => {
      let stored: ReviewDigestConfig | null = null;
      try {
        stored = await getReviewDigestConfig(pool, secretKey!);
      } catch {
        // stored under another key: its secrets are lost and must be given again
      }
      const cfg = validateReviewDigest(req.body, stored);
      if (typeof cfg === "string") return reply.code(400).send({ error: cfg });
      await saveReviewDigestConfig(pool, secretKey!, cfg, req.instance!.user_id);
      return reply.code(204).send();
    },
  );

  app.get("/v1/settings", async (req) => {
    const { rows } = await pool.query<{ set_at: Date }>("select set_at from settings where key = $1", [AGENT_CREDENTIAL]);
    const review_digest = req.instance!.role === "curator" && secretKey ? await reviewDigestView(pool, secretKey) : null;
    return { agent_credential: { present: rows.length > 0, set_at: rows[0]?.set_at.toISOString() ?? null }, review_digest };
  });
}
