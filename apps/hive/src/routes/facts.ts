import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { createFact, FACT_COLUMNS, FACT_KINDS, NotAllowedError, retractFact, type Fact } from "../facts.js";
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

interface CreateBody {
  text: string;
  kind: (typeof FACT_KINDS)[number];
  scope: string;
  repo_key?: string;
  locus?: string[];
  anchors?: Record<string, unknown>[];
}

export function factRoutes(app: FastifyInstance, pool: pg.Pool, onWrite: () => void): void {
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
          },
        },
      },
    },
    async (req, reply) => {
      const who = req.instance!;
      let scope: string;
      try {
        scope = resolveScope(req.body.scope, who, req.body.repo_key);
      } catch (err) {
        if (err instanceof ScopeError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      const { fact, deduped } = await createFact(
        pool,
        { text: req.body.text, kind: req.body.kind, scope, origin: "authored", locus: req.body.locus, anchors: req.body.anchors },
        who,
      );
      if (!deduped) onWrite();
      return reply.code(deduped ? 200 : 201).send({ fact, deduped });
    },
  );

  app.get<{ Querystring: { scope?: string; status?: string; kind?: string; repo_key?: string; limit?: number; offset?: number } }>(
    "/v1/facts",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            scope: { type: "string" },
            status: { type: "string", enum: ["candidate", "active", "superseded", "retracted"] },
            kind: { type: "string", enum: [...FACT_KINDS] },
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
      params.push(qs.limit ?? 50, qs.offset ?? 0);
      const { rows } = await pool.query<Fact>(
        `select ${FACT_COLUMNS} from facts where ${where.join(" and ")}
         order by recorded_at desc limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      return { facts: rows };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/facts/:id",
    { schema: { params: { type: "object", properties: { id: { type: "string", format: "uuid" } } } } },
    async (req, reply) => {
      const who = req.instance!;
      const [scopeSql, params] = readableScopes(who, undefined, 2);
      const { rows } = await pool.query<Fact>(
        `select ${FACT_COLUMNS} from facts where id = $1 and ${scopeSql}`,
        [req.params.id, ...params],
      );
      if (!rows[0]) return reply.code(404).send({ error: "no such fact" });
      const anchors = await pool.query(
        `select id, episode_id, repo_key, commit_sha, path, line_start, line_end, quote, verify_status, verified_at
         from anchors where fact_id = $1`,
        [req.params.id],
      );
      return { fact: rows[0], anchors: anchors.rows };
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
}
