import type { FastifyInstance } from "fastify";
import type pg from "pg";

interface Body {
  kind: "turn" | "session";
  session_id: string;
  content: string;
  repo_key?: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}

/** Immutable evidence from a Hermes instance. Who sent it comes from the token, not the body. */
export function episodeRoutes(app: FastifyInstance, pool: pg.Pool, onWrite: () => void): void {
  app.post<{ Body: Body }>(
    "/v1/episodes",
    {
      bodyLimit: 5 * 1024 * 1024, // whole-session transcripts
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "session_id", "content"],
          properties: {
            kind: { type: "string", enum: ["turn", "session"] },
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
      const { rows } = await pool.query<{ id: string; created_at: string }>(
        `insert into episodes (kind, instance_id, user_id, session_id, repo_key, ref, content, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, created_at`,
        [b.kind, who.id, who.user_id, b.session_id, b.repo_key ?? null, b.ref ?? null, b.content, b.metadata ?? {}],
      );
      onWrite();
      return reply.code(201).send({ episode: rows[0] });
    },
  );
}
