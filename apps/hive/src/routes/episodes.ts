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

/** An asf_run is a plan plus the review of the finished work, recorded once the PR is merged. */
const ASF_RUN_MAX_BYTES = 200 * 1024;
const ASF_RUN_MAX_PATHS = 500;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

type Episode = { id: string; created_at: string };

/** Why an asf_run's metadata is unusable, or null. A run record needs merged_at; the rest is optional but typed. */
function asfRunMetadataError(m: Record<string, unknown>): string | null {
  if (m.merged_at === undefined || m.merged_at === null) return "asf_run needs metadata.merged_at";
  if (typeof m.merged_at !== "string" || !ISO_TIME.test(m.merged_at) || Number.isNaN(Date.parse(m.merged_at))) {
    return "metadata.merged_at must be an ISO time";
  }
  for (const k of ["pr_url", "title"]) {
    if (m[k] !== undefined && typeof m[k] !== "string") return `metadata.${k} must be a string`;
  }
  if (m.paths !== undefined) {
    if (!Array.isArray(m.paths) || !m.paths.every((p) => typeof p === "string")) return "metadata.paths must be an array of strings";
    if (m.paths.length > ASF_RUN_MAX_PATHS) return `metadata.paths has more than ${ASF_RUN_MAX_PATHS} entries`;
  }
  return null;
}

/**
 * Evidence from a Hermes instance or the software factory. Who sent it comes from the token, not the body.
 * An asf_run is a run record, keyed by (repo_key, ref): a repost keeps the first content, replaces the metadata,
 * and returns 200 deduped. Only inserts queue a distill job (and asf_run is not distilled at all).
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
        const bad = asfRunMetadataError(b.metadata ?? {});
        if (bad) return reply.code(400).send({ error: bad });
      }
      const { rows } = await pool.query<Episode & { inserted: boolean }>(
        `insert into episodes (kind, instance_id, user_id, session_id, repo_key, ref, content, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (repo_key, ref) where kind = 'asf_run' do update set metadata = excluded.metadata
         returning id, created_at, xmax = 0 as inserted`,
        [b.kind, who.id, who.user_id, b.session_id ?? null, b.repo_key ?? null, b.ref ?? null, b.content, b.metadata ?? {}],
      );
      const { inserted, ...episode } = rows[0]!;
      if (!inserted) return reply.code(200).send({ episode, deduped: true });
      onWrite();
      return reply.code(201).send({ episode, deduped: false });
    },
  );
}
