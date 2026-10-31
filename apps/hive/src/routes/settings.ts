import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { decryptSecret, encryptSecret } from "../secrets.js";

const AGENT_CREDENTIAL = "agent_credential";

/** The fact agent's credential (e.g. a `claude setup-token` OAuth token), decrypted; null when not set. */
export async function getAgentCredential(pool: pg.Pool, key: Buffer): Promise<string | null> {
  const { rows } = await pool.query<{ value_enc: Buffer }>("select value_enc from settings where key = $1", [AGENT_CREDENTIAL]);
  return rows[0] ? decryptSecret(rows[0].value_enc, key) : null;
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

  app.get("/v1/settings", async () => {
    const { rows } = await pool.query<{ set_at: Date }>("select set_at from settings where key = $1", [AGENT_CREDENTIAL]);
    return { agent_credential: { present: rows.length > 0, set_at: rows[0]?.set_at.toISOString() ?? null } };
  });
}
