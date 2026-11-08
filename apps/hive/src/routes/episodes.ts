import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Instance } from "../auth.js";
import { userTurns } from "../distill.js";
import { flagCorrection } from "../facts.js";
import { readableScopes } from "../scope.js";

interface Body {
  kind: "turn" | "session" | "asf_run" | "asf_dialog";
  session_id?: string;
  content: string;
  repo_key?: string;
  ref?: string;
  metadata?: Record<string, unknown>;
}

/** An asf_run is a plan plus the review of the finished work, recorded once the PR is merged. An asf_dialog has the same limit. */
const ASF_RUN_MAX_BYTES = 200 * 1024;
const ASF_RUN_MAX_PATHS = 500;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

type Episode = { id: string; created_at: string };

/** A turn's metadata.cited: the [hive:<id>] prefixes its answer cited. */
const MAX_CITED = 20;
const CITED_PREFIX = /^[0-9a-fA-F-]{8,36}$/;

function citedError(cited: unknown): string | null {
  if (!Array.isArray(cited) || cited.length > MAX_CITED || !cited.every((c) => typeof c === "string" && CITED_PREFIX.test(c))) {
    return `metadata.cited must be an array of at most ${MAX_CITED} fact id prefixes`;
  }
  return null;
}

/**
 * The facts a turn's cited prefixes name. A prefix counts only when it names exactly one active fact the sender can
 * read (any repo, like /v1/facts/:id); an ambiguous or unknown prefix is ignored.
 */
async function resolveCited(pool: pg.Pool, who: Instance, cited: string[]): Promise<string[]> {
  const prefixes = [...new Set(cited.map((c) => c.toLowerCase()))];
  const [scopeSql, scopeParams] = readableScopes(who, undefined, 2, "f.scope");
  const { rows } = await pool.query<{ id: string }>(
    `select min(f.id::text) as id from unnest($1::text[]) p
     join facts f on f.id::text like p || '%' and f.status = 'active' and ${scopeSql}
     group by p having count(*) = 1`,
    [prefixes, ...scopeParams],
  );
  return [...new Set(rows.map((r) => r.id))];
}

/** Count a citation once per fact per turn (see resolveCited). */
async function recordCitations(pool: pg.Pool, who: Instance, cited: string[]): Promise<void> {
  const ids = await resolveCited(pool, who, cited);
  if (!ids.length) return;
  await pool.query("update facts set cite_count = cite_count + 1, last_used_at = now() where id = any($1::uuid[])", [ids]);
}

/**
 * A turn marked `metadata.correction`: the person corrected the answer before it. Each fact the previous turn of this
 * session by the same instance cited (resolved as in resolveCited) is flagged with this turn's user text.
 */
async function flagCorrected(pool: pg.Pool, who: Instance, episode: { id: string; content: string }): Promise<void> {
  const prev = await pool.query<{ cited: unknown }>(
    `select p.metadata->'cited' as cited from episodes e join episodes p
       on p.kind = 'turn' and p.session_id = e.session_id and p.instance_id = e.instance_id and p.created_at < e.created_at
     where e.id = $1 order by p.created_at desc, p.id desc limit 1`,
    [episode.id],
  );
  const cited = prev.rows[0]?.cited;
  if (!Array.isArray(cited) || !cited.length || citedError(cited)) return;
  const said = userTurns(episode.content).find((t) => t.startsWith("user: "));
  const text = said ? said.slice("user: ".length) : episode.content;
  for (const id of await resolveCited(pool, who, cited as string[])) {
    await flagCorrection(pool, id, { text, episode_id: episode.id, candidate_id: null });
  }
}

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
 * An asf_dialog is what a person said to the factory (a gate note on a plan, an answer to its question) after the
 * bot's text, keyed by (repo_key, ref) too: a repost changes nothing and returns 200 deduped. It is distilled like a
 * session, so it needs a `user: ` line, and metadata.author names the person.
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
            kind: { type: "string", enum: ["turn", "session", "asf_run", "asf_dialog"] },
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
      if (b.kind === "asf_dialog") {
        if (!b.repo_key || !b.ref?.trim()) return reply.code(400).send({ error: "asf_dialog needs repo_key and ref" });
        if (Buffer.byteLength(b.content) > ASF_RUN_MAX_BYTES) {
          return reply.code(413).send({ error: `asf_dialog content is over ${ASF_RUN_MAX_BYTES} bytes` });
        }
        const known = await pool.query("select 1 from repos where key = $1", [b.repo_key]);
        if (!known.rowCount) return reply.code(400).send({ error: "unknown repo_key" });
        if (!b.content.split("\n").some((l) => l.startsWith("user: "))) {
          return reply.code(400).send({ error: "asf_dialog content needs a line starting with \"user: \"" });
        }
        const author = b.metadata?.author;
        if (typeof author !== "string" || !author.trim()) {
          return reply.code(400).send({ error: "asf_dialog needs metadata.author" });
        }
        const { rows } = await pool.query<Episode>(
          `insert into episodes (kind, instance_id, user_id, session_id, repo_key, ref, content, metadata)
           values ('asf_dialog', $1, $2, $3, $4, $5, $6, $7)
           on conflict (repo_key, ref) where kind = 'asf_dialog' do nothing
           returning id, created_at`,
          [who.id, who.user_id, b.session_id ?? null, b.repo_key, b.ref, b.content, b.metadata],
        );
        if (!rows[0]) {
          const existing = await pool.query<Episode>(
            "select id, created_at from episodes where kind = 'asf_dialog' and repo_key = $1 and ref = $2",
            [b.repo_key, b.ref],
          );
          return reply.code(200).send({ episode: existing.rows[0], deduped: true });
        }
        onWrite();
        return reply.code(201).send({ episode: rows[0], deduped: false });
      }
      if (b.kind !== "asf_run") {
        if (!b.session_id) return reply.code(400).send({ error: `session_id is required for kind ${b.kind}` });
        if (b.kind === "turn" && b.metadata?.cited !== undefined) {
          const bad = citedError(b.metadata.cited);
          if (bad) return reply.code(400).send({ error: bad });
        }
        if (b.kind === "turn" && b.metadata?.correction !== undefined && typeof b.metadata.correction !== "boolean") {
          return reply.code(400).send({ error: "metadata.correction must be a boolean" });
        }
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
      if (b.kind === "turn" && b.metadata?.cited !== undefined) {
        await recordCitations(pool, who, b.metadata.cited as string[]).catch((err) => req.log.warn({ err }, "citations not recorded"));
      }
      if (b.kind === "turn" && b.metadata?.correction === true) {
        await flagCorrected(pool, who, { id: episode.id, content: b.content }).catch((err) =>
          req.log.warn({ err }, "correction not flagged"),
        );
      }
      onWrite();
      return reply.code(201).send({ episode, deduped: false });
    },
  );
}
