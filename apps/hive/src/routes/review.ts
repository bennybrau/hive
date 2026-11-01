import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { ConflictError, FACT_COLUMNS, reviewFact, type Fact, type ReviewInput } from "../facts.js";
import { readableScopes } from "../scope.js";

/** Cosine floor for "a fact like this already exists" hints in the queue. */
const SIMILAR_MIN = 0.85;
const SNIPPET_CHARS = 300;

function curatorOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.instance!.role === "curator") return true;
  reply.code(403).send({ error: "only a curator can review facts" });
  return false;
}

/** The review gate: curators see shared-scope candidates oldest first and approve, fix or reject them. */
export function reviewRoutes(app: FastifyInstance, pool: pg.Pool, onWrite: () => void): void {
  app.get<{ Querystring: { scope?: string; origin?: string; limit?: number } }>(
    "/v1/review/queue",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            scope: { type: "string" },
            origin: { type: "string", enum: ["authored", "distilled", "ingested"] },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      const qs = req.query;
      // Distilled personal facts are candidates too; a curator never sees another user's.
      const [scopeSql, params] = readableScopes(req.instance!, undefined, 1);
      const where = ["status = 'candidate'", scopeSql];
      if (qs.scope) {
        params.push(qs.scope);
        where.push(`scope = $${params.length}`);
      }
      if (qs.origin) {
        params.push(qs.origin);
        where.push(`origin = $${params.length}`);
      }
      params.push(qs.limit ?? 20);
      const { rows: candidates } = await pool.query<Fact & { supersedes: string | null }>(
        `select ${FACT_COLUMNS}, supersedes from facts where ${where.join(" and ")}
         order by recorded_at, id limit $${params.length}`,
        params,
      );
      const ids = candidates.map((c) => c.id);
      // Anchors, and for conversation anchors ~300 chars of the episode around the quote (start of it when not found).
      const anchors = await pool.query<{ fact_id: string }>(
        `select a.fact_id, a.id, a.episode_id, a.repo_key, a.commit_sha, a.path, a.line_start, a.line_end, a.quote,
                a.verify_status, a.verified_at, a.verify_note,
                case when e.id is null then null
                     else substr(e.content, greatest(1,
                       coalesce(nullif(strpos(lower(e.content), lower(coalesce(a.quote, ''))), 0), 1)
                       + length(coalesce(a.quote, '')) / 2 - ${SNIPPET_CHARS / 2}), ${SNIPPET_CHARS})
                end as episode_snippet
         from anchors a left join episodes e on e.id = a.episode_id
         where a.fact_id = any($1::uuid[])`,
        [ids],
      );
      // Up to 3 active facts very close in meaning, in the candidate's scope or global. Not embedded yet -> none.
      const similar = await pool.query<{ candidate_id: string; similarity: number }>(
        `select c.id as candidate_id, s.* from facts c
         cross join lateral (
           select ${FACT_COLUMNS}, 1 - (f.embedding <=> c.embedding) as similarity from facts f
           where f.status = 'active' and f.embedding is not null and (f.scope = c.scope or f.scope = 'global')
           order by f.embedding <=> c.embedding limit 3
         ) s
         where c.id = any($1::uuid[]) and c.embedding is not null and s.similarity >= $2
         order by s.similarity desc`,
        [ids, SIMILAR_MIN],
      );
      // When the distiller last finished a job, so an empty queue can say how fresh it is.
      const lastDistill = await pool.query<{ at: Date | null }>(
        "select max(finished_at) as at from distill_jobs where status = 'done'",
      );
      const at = lastDistill.rows[0]?.at ?? null;
      return {
        last_distill_at: at ? at.toISOString() : null,
        candidates: candidates.map((c) => ({
          ...c,
          anchors: anchors.rows.filter((a) => a.fact_id === c.id).map(({ fact_id: _, ...a }) => a),
          similar: similar.rows
            .filter((s) => s.candidate_id === c.id)
            .map(({ candidate_id: _, ...s }) => ({ ...s, similarity: Number(s.similarity) })),
        })),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: ReviewInput }>(
    "/v1/facts/:id/review",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["approve", "fix", "reject"] },
            note: { type: "string", maxLength: 1000 },
            new_text: { type: "string", minLength: 3, maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      if (req.body.action === "fix" && !req.body.new_text) return reply.code(400).send({ error: "fix needs new_text" });
      try {
        const out = await reviewFact(pool, req.params.id, req.instance!, req.body);
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
