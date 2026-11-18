import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";

export const ROLES = ["member", "curator", "worker"] as const;
export type Role = (typeof ROLES)[number];

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

/** last_seen_at is written at most once a minute per instance, not on every request. */
export async function findInstanceByToken(pool: pg.Pool, token: string): Promise<Instance | null> {
  const { rows } = await pool.query<Instance>(
    "select id, name, user_id, role from instances where token_hash = $1 and revoked_at is null",
    [hashToken(token)],
  );
  const instance = rows[0];
  if (!instance) return null;
  await pool.query(
    `update instances set last_seen_at = now()
     where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '60 seconds')`,
    [instance.id],
  );
  return instance;
}

/** A new token for an unrevoked instance; the old one stops working at once. null = unknown or revoked. */
export async function rotateInstanceToken(
  pool: pg.Pool,
  id: string,
): Promise<{ instance: Instance; token: string } | null> {
  const token = generateToken();
  const { rows } = await pool.query<Instance>(
    `update instances set token_hash = $2, rotated_at = now()
     where id = $1 and revoked_at is null
     returning id, name, user_id, role`,
    [id, hashToken(token)],
  );
  return rows[0] ? { instance: rows[0], token } : null;
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

/** A worker token (the fact-agent container) may only reach its own endpoints and /v1/status. */
export async function confineWorker(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.instance?.role !== "worker") return;
  const path = req.url.split("?", 1)[0]!;
  if (path === "/v1/status" || path.startsWith("/v1/worker/")) return;
  return reply.code(403).send({ error: "worker tokens can only use /v1/worker/*" });
}

export function workerOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.instance!.role === "worker") return true;
  reply.code(403).send({ error: "only a worker token can use this endpoint" });
  return false;
}
