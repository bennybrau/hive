import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";

export type Role = "curator" | "member";

export interface Instance {
  id: string;
  name: string;
  user_id: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    instance?: Instance;
  }
}

export const TOKEN_PREFIX = "hive_";

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Only the hash is stored; a leaked DB does not leak usable tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createInstance(
  pool: pg.Pool,
  opts: { name: string; userId: string; role?: Role },
): Promise<{ instance: Instance; token: string }> {
  const token = generateToken();
  const { rows } = await pool.query<Instance>(
    `insert into instances (name, user_id, role, token_hash) values ($1, $2, $3, $4)
     returning id, name, user_id, role`,
    [opts.name, opts.userId, opts.role ?? "member", hashToken(token)],
  );
  return { instance: rows[0]!, token };
}

export async function findInstanceByToken(pool: pg.Pool, token: string): Promise<Instance | null> {
  const { rows } = await pool.query<Instance>(
    `update instances set last_seen_at = now()
     where token_hash = $1 and revoked_at is null
     returning id, name, user_id, role`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export function bearerAuth(pool: pg.Pool) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      return reply.code(401).send({ error: "missing bearer token", hint: "send Authorization: Bearer <HIVE_TOKEN>" });
    }
    const instance = await findInstanceByToken(pool, match[1]!);
    if (!instance) {
      return reply.code(401).send({ error: "unknown or revoked token", hint: "mint one with scripts/setup.sh or `pnpm mint-token`" });
    }
    req.instance = instance;
  };
}
