import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { createInstance, ROLES, rotateInstanceToken, type Role } from "../auth.js";

/** Everything about an instance except its token_hash, which never leaves the database. */
const PUBLIC_COLUMNS = "id, name, user_id, role, created_at, last_seen_at, revoked_at, rotated_at";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function curatorOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.instance!.role === "curator") return true;
  reply.code(403).send({ error: "only a curator can manage tokens" });
  return false;
}

/** The public row, or null for a non-uuid or unknown id (both 404, not 400). */
async function findInstance(pool: pg.Pool, id: string): Promise<Record<string, unknown> | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query(`select ${PUBLIC_COLUMNS} from instances where id = $1`, [id]);
  return rows[0] ?? null;
}

/** Curator only (workers are already confined): list, create, revoke and rotate instance tokens. */
export function tokenRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get<{ Querystring: { revoked?: boolean } }>(
    "/v1/instances",
    { schema: { querystring: { type: "object", properties: { revoked: { type: "boolean" } } } } },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      const { rows } = await pool.query(
        `select ${PUBLIC_COLUMNS} from instances ${req.query.revoked ? "" : "where revoked_at is null"} order by created_at`,
      );
      return { instances: rows };
    },
  );

  app.post<{ Body: { name: string; user_id: string; role: Role } }>(
    "/v1/instances",
    {
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["name", "user_id", "role"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            user_id: { type: "string", minLength: 1, maxLength: 200 },
            role: { type: "string", enum: [...ROLES] },
          },
        },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      const { name, user_id, role } = req.body;
      try {
        const { instance, token } = await createInstance(pool, { name, userId: user_id, role });
        return reply.code(201).send({ instance: await findInstance(pool, instance.id), token });
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          return reply.code(409).send({ error: `an instance named "${name}" already exists (revoked ones keep their name)` });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>("/v1/instances/:id/revoke", async (req, reply) => {
    if (!curatorOnly(req, reply)) return reply;
    const existing = await findInstance(pool, req.params.id);
    if (!existing) return reply.code(404).send({ error: "no such instance" });
    if (existing.id === req.instance!.id) {
      return reply.code(409).send({ error: "you can't revoke the token you are calling with; rotate it instead" });
    }
    const { rows } = await pool.query(
      `update instances set revoked_at = now() where id = $1 and revoked_at is null returning ${PUBLIC_COLUMNS}`,
      [existing.id],
    );
    if (!rows[0]) return reply.code(409).send({ error: "this token is already revoked" });
    return { instance: rows[0] };
  });

  app.post<{ Params: { id: string } }>("/v1/instances/:id/rotate", async (req, reply) => {
    if (!curatorOnly(req, reply)) return reply;
    const existing = await findInstance(pool, req.params.id);
    if (!existing) return reply.code(404).send({ error: "no such instance" });
    const rotated = await rotateInstanceToken(pool, req.params.id);
    if (!rotated) return reply.code(409).send({ error: "a revoked token can't be rotated; create a new one" });
    return { instance: await findInstance(pool, rotated.instance.id), token: rotated.token };
  });
}
