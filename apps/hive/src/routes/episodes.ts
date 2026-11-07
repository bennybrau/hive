import type { FastifyInstance } from "fastify";
import type pg from "pg";

interface Body {
  kind: "turn" | "session" | "asf_run";
  session_id?: string;
  content: string;
  repo_key?: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}

/** An asf_run is a plan plus the review of the finished work; the distill reads it in one or two chunks. */
const ASF_RUN_MAX_BYTES = 200 * 1024;

type Episode = { id: string; created_at: string };

/**
 * Immutable evidence from a Hermes instance or the software factory. Who sent it comes from the token, not the
 * body. An asf_run is keyed by (repo_key, ref): a repost returns the stored episode and queues nothing.
 */
export function episodeRoutes(app: FastifyInstance, pool: pg.Pool, onWrite: () => void): void {
  app.post<{ Body: Body }>(
    "/v1/episodes",
    {
      bodyLimit: 5 * 1024 * 1024, // whole-session transcripts
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "content"],
          properties: {
            kind: { type: "string", enum: ["turn", "session", "asf_run"] },
            session_id: { type: "string", minLength: 1, maxLength: 200 },
            content: { type: "string", minLength: 1, maxLength: 4_000_000 },
            repo_key: { type: "string", minLength: 1, maxLength: 200 },
            ref: { type: "string", maxLength: 200 },
            metadata: { type: "object" },
          },
        },
      },
    },
    async (req, reply) => {
      const who = req.instance!;
      const b = req.body;
      if (b.kind !== "asf_run") {
        if (!b.session_id) return reply.code(400).send({ error: `session_id is required for kind ${b.kind}` });
      } else {
        if (!b.repo_key || !b.ref?.trim()) return reply.code(400).send({ error: "asf_run needs repo_key and ref" });
        if (Buffer.byteLength(b.content) > ASF_RUN_MAX_BYTES) {
          return reply.code(413).send({ error: `asf_run content is over ${ASF_RUN_MAX_BYTES} bytes` });
        }
        const known = await pool.query("select 1 from repos where key = $1", [b.repo_key]);
        if (!known.rowCount) return reply.code(400).send({ error: "unknown repo_key" });
      }
      const { rows } = await pool.query<Episode>(
        `insert into episodes (kind, instance_id, user_id, session_id, repo_key, ref, content, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (repo_key, ref) where kind = 'asf_run' do nothing
         returning id, created_at`,
        [b.kind, who.id, who.user_id, b.session_id ?? null, b.repo_key ?? null, b.ref ?? null, b.content, b.metadata ?? {}],
      );
      if (!rows[0]) {
        const existing = await pool.query<Episode>(
          "select id, created_at from episodes where kind = 'asf_run' and repo_key = $1 and ref = $2",
          [b.repo_key, b.ref],
        );
        return reply.code(200).send({ episode: existing.rows[0], deduped: true });
      }
      onWrite();
      return reply.code(201).send({ episode: rows[0], deduped: false });
    },
  );
}
