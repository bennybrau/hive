import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Instance } from "../auth.js";
import {
  ConflictError,
  createFact,
  curateFact,
  FACT_COLUMNS,
  FACT_KINDS,
  factChain,
  IDLE_SQL,
  NotAllowedError,
  retractFact,
  staleSql,
  SupersedeError,
  type CurateInput,
  type Fact,
} from "../facts.js";
import { readableScopes, resolveScope, ScopeError } from "../scope.js";

const anchorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    episode_id: { type: "string", format: "uuid" },
    repo_key: { type: "string", maxLength: 200 },
    commit_sha: { type: "string", maxLength: 64 },
    path: { type: "string", maxLength: 1000 },
    line_start: { type: "integer", minimum: 1 },
    line_end: { type: "integer", minimum: 1 },
    quote: { type: "string", maxLength: 4000 },
  },
} as const;

/** List, detail and the stale list also show how much a fact is used and whether it's pinned; other responses keep FACT_COLUMNS. */
const FACT_USE_COLUMNS = `${FACT_COLUMNS}, use_count, cite_count, last_used_at, pinned`;

export interface CreateBody {
  text: string;
  kind: (typeof FACT_KINDS)[number];
  scope: string;
  repo_key?: string;
  locus?: string[];
  anchors?: Record<string, unknown>[];
  supersedes?: string;
}

/**
 * POST /v1/facts and MCP hive_remember: an authored fact; its status follows initialStatus (a member's shared fact is a candidate).
 * ScopeError for a scope the caller can't write, SupersedeError for a bad supersedes.
 */
export async function remember(pool: pg.Pool, who: Instance, b: CreateBody, onWrite: () => void): Promise<{ fact: Fact; deduped: boolean }> {
  const scope = resolveScope(b.scope, who, b.repo_key);
  const res = await createFact(
    pool,
    { text: b.text, kind: b.kind, scope, origin: "authored", locus: b.locus, anchors: b.anchors, supersedes: b.supersedes },
    who,
  );
  if (!res.deduped) onWrite();
  return res;
}

export function factRoutes(app: FastifyInstance, pool: pg.Pool, onWrite: () => void, staleDays: number): void {
  const listColumns = `${FACT_USE_COLUMNS}, ${staleSql(staleDays)} as stale`;

  /** remember: authored by the calling instance. distilled/ingested facts come from jobs, not this endpoint. */
  app.post<{ Body: CreateBody }>(
    "/v1/facts",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["text", "kind", "scope"],
          properties: {
            text: { type: "string", minLength: 3, maxLength: 2000 },
            kind: { type: "string", enum: [...FACT_KINDS] },
            scope: { type: "string", minLength: 1, maxLength: 220 },
            repo_key: { type: "string", minLength: 1, maxLength: 200 },
            locus: { type: "array", maxItems: 50, items: { type: "string", maxLength: 500 } },
            anchors: { type: "array", maxItems: 20, items: anchorSchema },
            supersedes: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { fact, deduped } = await remember(pool, req.instance!, req.body, onWrite);
        return reply.code(deduped ? 200 : 201).send({ fact, deduped });
      } catch (err) {
        if (err instanceof ScopeError || err instanceof SupersedeError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get<{
    Querystring: { scope?: string; status?: string; kind?: string; origin?: string; repo_key?: string; limit?: number; offset?: number };
  }>(
    "/v1/facts",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            scope: { type: "string" },
            status: { type: "string", enum: ["candidate", "active", "superseded", "retracted"] },
            kind: { type: "string", enum: [...FACT_KINDS] },
            origin: { type: "string", enum: ["authored", "distilled", "ingested"] },
            repo_key: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req) => {
      const who = req.instance!;
      const qs = req.query;
      const [scopeSql, params] = readableScopes(who, qs.repo_key, 1);
      const where = [scopeSql];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (qs.scope) add("scope = ?", qs.scope === "personal" ? `personal:${who.user_id}` : qs.scope);
      if (qs.status) add("status = ?", qs.status);
      if (qs.kind) add("kind = ?", qs.kind);
      if (qs.origin) add("origin = ?", qs.origin);
      const limit = qs.limit ?? 50;
      params.push(limit + 1, qs.offset ?? 0); // one extra row tells us whether there's another page
      const { rows } = await pool.query<Fact>(
        `select ${listColumns} from facts where ${where.join(" and ")}
         order by recorded_at desc, id desc limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      const has_more = rows.length > limit;
      return { facts: has_more ? rows.slice(0, limit) : rows, has_more };
    },
  );

  /** Curator only: active, unpinned facts idle (no use, no keep) for more than staleDays, longest idle first. */
  app.get<{ Querystring: { repo_key?: string; limit?: number; offset?: number } }>(
    "/v1/facts/stale",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            repo_key: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            offset: { type: "integer", minimum: 0, default: 0 },
          },
        },
      },
    },
    async (req, reply) => {
      const who = req.instance!;
      if (who.role !== "curator") return reply.code(403).send({ error: "only a curator can list stale facts" });
      const [scopeSql, params] = readableScopes(who, req.query.repo_key, 1);
      const limit = req.query.limit ?? 50;
      params.push(limit + 1, req.query.offset ?? 0);
      const { rows } = await pool.query<Fact>(
        `select ${FACT_USE_COLUMNS}, floor(extract(epoch from now() - ${IDLE_SQL}) / 86400)::int as idle_days
         from facts where ${scopeSql} and ${staleSql(staleDays)}
         order by ${IDLE_SQL}, id limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      const has_more = rows.length > limit;
      return { facts: has_more ? rows.slice(0, limit) : rows, has_more, stale_days: staleDays };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/facts/:id",
    { schema: { params: { type: "object", properties: { id: { type: "string", format: "uuid" } } } } },
    async (req, reply) => {
      const who = req.instance!;
      const [scopeSql, params] = readableScopes(who, undefined, 2);
      const { rows } = await pool.query<Fact>(
        `select ${listColumns} from facts where id = $1 and ${scopeSql}`,
        [req.params.id, ...params],
      );
      if (!rows[0]) return reply.code(404).send({ error: "no such fact" });
      const anchors = await pool.query(
        `select a.id, a.episode_id, a.repo_key, a.commit_sha, a.path, a.line_start, a.line_end, a.quote,
                a.verify_status, a.verified_at, a.verify_note, a.found_line, r.remote_url
         from anchors a left join repos r on r.key = a.repo_key where a.fact_id = $1`,
        [req.params.id],
      );
      const reviews = await pool.query(
        `select action, note, new_text, reviewer_user_id, created_at from reviews where fact_id = $1 order by created_at, id`,
        [req.params.id],
      );
      return { fact: rows[0], anchors: anchors.rows, reviews: reviews.rows, ...(await factChain(pool, req.params.id)) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/v1/facts/:id/retract",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["reason"],
          additionalProperties: false,
          properties: { reason: { type: "string", minLength: 3, maxLength: 1000 } },
        },
      },
    },
    async (req, reply) => {
      try {
        const fact = await retractFact(pool, req.params.id, req.instance!, req.body.reason);
        if (!fact) return reply.code(404).send({ error: "no such fact" });
        return { fact };
      } catch (err) {
        if (err instanceof NotAllowedError) return reply.code(403).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: CurateInput }>(
    "/v1/facts/:id/curate",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["action"],
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["keep", "fix", "retire", "pin", "unpin"] },
            note: { type: "string", maxLength: 1000 },
            new_text: { type: "string", minLength: 3, maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      if (req.instance!.role !== "curator") return reply.code(403).send({ error: "only a curator can curate facts" });
      if (req.body.action === "fix" && !req.body.new_text) return reply.code(400).send({ error: "fix needs new_text" });
      try {
        const out = await curateFact(pool, req.params.id, req.instance!, req.body);
        if (!out) return reply.code(404).send({ error: "no such fact" });
        if (req.body.action === "fix") onWrite();
        return out;
      } catch (err) {
        if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );
}
