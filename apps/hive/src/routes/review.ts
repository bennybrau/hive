import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { exchangeFor } from "../distill.js";
import { ConflictError, FACT_COLUMNS, reviewFact, type ReviewInput } from "../facts.js";
import { loadReviewQueueItems } from "../review-queue.js";
import { ScopeError, ScopeNotFound } from "../scope.js";

/** Cosine floor for "a fact like this already exists" hints in the queue. */
const SIMILAR_MIN = 0.85;
const SNIPPET_CHARS = 300;

interface SourceColumns {
  ep_kind: string | null;
  ep_ref: string | null;
  ep_user_id: string | null;
  ep_author: string | null;
  ep_at: Date | null;
}

/** Not people: the factory's own user id, and the name the factory records for a message sent through its API
 *  without one. Never shown as who said something. */
const NOT_A_PERSON = new Set(["asf-factory", "operator"]);

/** Where an anchor's episode came from, in words the dashboard maps to a label; null without an episode. */
function sourceOf(row: SourceColumns): { kind: string; author: string | null; where: string; at: string } | null {
  if (row.ep_kind === null || row.ep_at === null) return null;
  const author = row.ep_author ?? row.ep_user_id ?? null;
  const ref = row.ep_ref ?? "";
  const where =
    row.ep_kind === "asf_dialog" && ref.includes(":gate:") ? "factory_plan_note"
    : row.ep_kind === "asf_dialog" && ref.includes(":msg:") ? "factory_chat"
    : row.ep_kind === "asf_run" ? "factory_run"
    : row.ep_kind === "turn" || row.ep_kind === "session" ? "conversation"
    : row.ep_kind === "commit" ? "commit"
    : "other";
  return { kind: row.ep_kind, author: author !== null && NOT_A_PERSON.has(author) ? null : author, where, at: row.ep_at.toISOString() };
}

function curatorOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.instance!.role === "curator") return true;
  reply.code(403).send({ error: "only a curator can review facts" });
  return false;
}

/**
 * The review gate: curators see shared-scope candidates (asked first, then oldest) and approve, fix or reject them,
 * and the active facts flagged as corrected (`flagged`, curated with /v1/facts/:id/curate).
 */
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
      const { candidates, flagged } = await loadReviewQueueItems(pool, req.instance!, { ...qs, limit: qs.limit ?? 20 });
      const ids = candidates.map((c) => c.id);
      // Anchors, and for conversation anchors ~300 chars of the episode around the quote (start of it when not found)
      // plus the exchange the quote came from; `content` is only read here, never sent.
      const anchors = await pool.query<{ fact_id: string; quote: string | null; content: string | null } & SourceColumns>(
        `select a.fact_id, a.id, a.episode_id, a.repo_key, a.commit_sha, a.path, a.line_start, a.line_end, a.quote,
                a.verify_status, a.verified_at, a.verify_note,
                case when e.id is null then null
                     else substr(e.content, greatest(1,
                       coalesce(nullif(strpos(lower(e.content), lower(coalesce(a.quote, ''))), 0), 1)
                       + length(coalesce(a.quote, '')) / 2 - ${SNIPPET_CHARS / 2}), ${SNIPPET_CHARS})
                end as episode_snippet, e.content,
                e.kind as ep_kind, e.ref as ep_ref, e.user_id as ep_user_id, e.metadata->>'author' as ep_author,
                e.created_at as ep_at
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
      // The fact each distilled candidate says it replaces, whatever its status now.
      const replaces = await pool.query<{ candidate_id: string; id: string; text: string; kind: string; scope: string; status: string }>(
        `select c.id as candidate_id, f.id, f.text, f.kind, f.scope, f.status
         from facts c join facts f on f.id = (c.metadata->>'replaces')::uuid
         where c.id = any($1::uuid[])`,
        [ids],
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
          anchors: anchors.rows
            .filter((a) => a.fact_id === c.id)
            .map(({ fact_id: _, content, ep_kind, ep_ref, ep_user_id, ep_author, ep_at, ...a }) => ({
              ...a,
              exchange: content === null ? null : exchangeFor(content, a.quote ?? ""),
              source: sourceOf({ ep_kind, ep_ref, ep_user_id, ep_author, ep_at }),
            })),
          similar: similar.rows
            .filter((s) => s.candidate_id === c.id)
            .map(({ candidate_id: _, ...s }) => ({ ...s, similarity: Number(s.similarity) })),
          replaces: replaces.rows.filter((r) => r.candidate_id === c.id).map(({ candidate_id: _, ...r }) => r)[0] ?? null,
        })),
        flagged,
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
            scope: { type: "string" },
          },
        },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      if (req.body.action === "fix" && !req.body.new_text) return reply.code(400).send({ error: "fix needs new_text" });
      if (req.body.action === "reject" && req.body.scope !== undefined) return reply.code(400).send({ error: "reject takes no scope" });
      try {
        const out = await reviewFact(pool, req.params.id, req.instance!, req.body);
        if (!out) return reply.code(404).send({ error: "no such fact" });
        if (req.body.action === "fix") onWrite();
        return out;
      } catch (err) {
        if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
        if (err instanceof ScopeNotFound) return reply.code(404).send({ error: err.message });
        if (err instanceof ScopeError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );
}
