import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { hostPathOf, inspectRepo, RepoError, repoKeyFromRemote, resolveRepoPath, type RepoRoots } from "../git.js";
import { RepoBusyError, type RepoSync } from "../jobs/repo-sync.js";
import { verifyAnchors } from "../jobs/verify.js";

export interface RepoDeps {
  roots: RepoRoots;
  sync: RepoSync;
}

function curatorOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.instance!.role === "curator") return true;
  void reply.code(403).send({ error: "curator only" });
  return false;
}

const KEY = { type: "string", minLength: 3, maxLength: 200, pattern: "^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$" } as const;

export function repoRoutes(app: FastifyInstance, pool: pg.Pool, deps: RepoDeps): void {
  /** Register a repo by path (host path under the repos root, or relative to it). Key defaults from origin. */
  app.post<{ Body: { path: string; key?: string } }>(
    "/v1/repos",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: { path: { type: "string", minLength: 1, maxLength: 1000 }, key: KEY },
        },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return;
      let info;
      try {
        const dir = await resolveRepoPath(req.body.path, deps.roots);
        info = await inspectRepo(dir);
      } catch (err) {
        if (err instanceof RepoError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      const key = req.body.key ?? (info.remoteUrl && repoKeyFromRemote(info.remoteUrl)) ?? "";
      if (!key) return reply.code(400).send({ error: "no origin remote to derive a key from; pass key (e.g. local/my-repo)" });
      const { rows } = await pool.query<{ inserted: boolean }>(
        `insert into repos (key, local_path, remote_url, default_branch) values ($1, $2, $3, $4)
         on conflict (key) do update set local_path = $2, remote_url = coalesce($3, repos.remote_url),
                                         default_branch = coalesce($4, repos.default_branch)
         returning (xmax = 0) as inserted`,
        [key, info.toplevel, info.remoteUrl, info.branch],
      );
      return reply.code(rows[0]!.inserted ? 201 : 200).send({
        repo: { key, host_path: hostPathOf(info.toplevel, deps.roots), remote_url: info.remoteUrl, default_branch: info.branch },
      });
    },
  );

  app.get("/v1/repos", async () => {
    const { rows } = await pool.query(
      `select r.key, r.local_path, r.remote_url, r.default_branch, r.last_ingested_sha, r.last_ingested_at,
              r.ingest_summary, r.ingest_error,
              (select count(*)::int from doc_files d where d.repo_key = r.key and d.status = 'indexed') as docs,
              (select count(*)::int from doc_chunks c where c.repo_key = r.key) as chunks,
              (select count(*)::int from episodes e where e.kind = 'commit' and e.repo_key = r.key) as commits
       from repos r order by r.key`,
    );
    return {
      repos: rows.map(({ local_path, ...r }) => ({ ...r, host_path: local_path ? hostPathOf(local_path, deps.roots) : null })),
    };
  });

  /** Files that were not indexed, and why (scanned PDFs, too big, unreadable). */
  app.get<{ Querystring: { key: string } }>(
    "/v1/repos/files",
    { schema: { querystring: { type: "object", required: ["key"], properties: { key: KEY } } } },
    async (req) => {
      const { rows } = await pool.query(
        "select path, status, note, chunks, ingested_at from doc_files where repo_key = $1 order by status <> 'indexed' desc, path",
        [req.query.key],
      );
      return { files: rows };
    },
  );

  /** Ingest now (incremental), then verify that repo's anchors. Waits for the result. */
  app.post<{ Body: { key: string } }>(
    "/v1/repos/ingest",
    { schema: { body: { type: "object", additionalProperties: false, required: ["key"], properties: { key: KEY } } } },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return;
      try {
        return await deps.sync.sync(req.body.key);
      } catch (err) {
        if (err instanceof RepoBusyError) return reply.code(409).send({ error: err.message });
        if (err instanceof RepoError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Body: { repo_key?: string } }>(
    "/v1/jobs/verify",
    { schema: { body: { type: "object", additionalProperties: false, properties: { repo_key: KEY } } } },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return;
      return { verify: await verifyAnchors(pool, { repoKey: req.body?.repo_key }) };
    },
  );
}
