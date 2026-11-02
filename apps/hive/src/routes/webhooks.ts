import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { encryptSecret } from "../secrets.js";
import { WEBHOOK_EVENTS } from "../webhooks.js";

const WEBHOOK_COLUMNS = "id, url, events, active, created_at, created_by_user_id, failing_since, last_error";
const DELIVERY_COLUMNS = "id, event, status, attempts, next_attempt_at, last_error, created_at, delivered_at";

interface Body {
  url?: string;
  events?: string[];
  active?: boolean;
  secret?: string;
}

const bodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", minLength: 1, maxLength: 2000 },
    events: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...WEBHOOK_EVENTS] } },
    active: { type: "boolean" },
    secret: { type: "string", minLength: 16, maxLength: 256 },
  },
} as const;
const idParams = { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } } as const;

function httpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Webhooks on fact changes. Curator only; secrets are stored encrypted and returned once, on create. */
export function webhookRoutes(app: FastifyInstance, pool: pg.Pool, secretKey: Buffer | null): void {
  const gate = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.instance!.role !== "curator") {
      reply.code(403).send({ error: "only a curator can manage webhooks" });
      return false;
    }
    if (!secretKey) {
      reply.code(503).send({ error: "HIVE_SECRET_KEY is not set" });
      return false;
    }
    return true;
  };

  app.post<{ Body: Body }>(
    "/v1/webhooks",
    { schema: { body: { ...bodySchema, required: ["url"] } } },
    async (req, reply) => {
      if (!gate(req, reply)) return reply;
      const b = req.body;
      if (!httpUrl(b.url!)) return reply.code(400).send({ error: "url must be http(s)" });
      const secret = b.secret ?? randomBytes(32).toString("hex");
      const { rows } = await pool.query(
        `insert into webhooks (url, secret_enc, events, active, created_by_user_id) values ($1, $2, $3, $4, $5)
         returning ${WEBHOOK_COLUMNS}`,
        [b.url, encryptSecret(secret, secretKey!), b.events ?? [...WEBHOOK_EVENTS], b.active ?? true, req.instance!.user_id],
      );
      return reply.code(201).send({ webhook: rows[0], secret });
    },
  );

  app.get("/v1/webhooks", async (req, reply) => {
    if (!gate(req, reply)) return reply;
    const { rows } = await pool.query(`select ${WEBHOOK_COLUMNS} from webhooks order by created_at, id`);
    return { webhooks: rows };
  });

  app.get<{ Params: { id: string } }>("/v1/webhooks/:id", { schema: { params: idParams } }, async (req, reply) => {
    if (!gate(req, reply)) return reply;
    const { rows } = await pool.query(`select ${WEBHOOK_COLUMNS} from webhooks where id = $1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: "no such webhook" });
    const deliveries = await pool.query(
      `select ${DELIVERY_COLUMNS} from webhook_deliveries where webhook_id = $1 order by created_at desc limit 20`,
      [req.params.id],
    );
    return { webhook: rows[0], deliveries: deliveries.rows };
  });

  app.patch<{ Params: { id: string }; Body: Body }>(
    "/v1/webhooks/:id",
    { schema: { params: idParams, body: { ...bodySchema, minProperties: 1 } } },
    async (req, reply) => {
      if (!gate(req, reply)) return reply;
      const b = req.body;
      if (b.url !== undefined && !httpUrl(b.url)) return reply.code(400).send({ error: "url must be http(s)" });
      const { rows } = await pool.query(
        `update webhooks set url = coalesce($2, url), events = coalesce($3, events), active = coalesce($4, active),
                secret_enc = coalesce($5, secret_enc)
         where id = $1 returning ${WEBHOOK_COLUMNS}`,
        [req.params.id, b.url ?? null, b.events ?? null, b.active ?? null, b.secret ? encryptSecret(b.secret, secretKey!) : null],
      );
      if (!rows[0]) return reply.code(404).send({ error: "no such webhook" });
      return { webhook: rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/webhooks/:id", { schema: { params: idParams } }, async (req, reply) => {
    if (!gate(req, reply)) return reply;
    const { rowCount } = await pool.query("delete from webhooks where id = $1", [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: "no such webhook" });
    return reply.code(204).send();
  });
}
