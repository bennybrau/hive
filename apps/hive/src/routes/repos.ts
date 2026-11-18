import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  cloneRepo, hostPathOf, inspectRepo, isUnder, parseCloneUrl, RepoError, repoKeyFromRemote, resolveRepoPath, type RepoRoots,
} from "../git.js";
import { RepoBusyError, type RepoSync } from "../jobs/repo-sync.js";
import { verifyAnchors } from "../jobs/verify.js";
import { encryptSecret } from "../secrets.js";

export interface RepoDeps {
  roots: RepoRoots;
  sync: RepoSync;
  /** Repos registered by URL are cloned to `<clonesRoot>/<key>` (default /data/repos, as config). */
  clonesRoot?: string;
  /** Accept file:// and local-path clone URLs (tests only). */
  allowFileUrls?: boolean;
  /** Encrypts a URL repo's token; null = registering with a token is 503. */
  secretKey?: Buffer | null;
}

function curatorOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.instance!.role === "curator") return true;
  void reply.code(403).send({ error: "curator only" });
  return false;
}

const KEY = { type: "string", minLength: 3, maxLength: 200, pattern: "^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$" } as const;
const TOKEN = { type: "string", minLength: 1, maxLength: 1000 } as const;
const keyParams = { type: "object", required: ["key"], properties: { key: KEY } } as const;
const NO_SECRET_KEY = "HIVE_SECRET_KEY is not set";

type RegisterBody = { path: string; key?: string } | { url: string; key?: string; token?: string };

export function repoRoutes(app: FastifyInstance, pool: pg.Pool, deps: RepoDeps): void {
  const clonesRoot = deps.clonesRoot ?? "/data/repos";
  /**
   * Register a repo by path (host path under the repos root, or relative to it), or by URL (cloned into
   * the clones root, fetched before every ingest). Key defaults from origin / the URL. Bodies are never logged.
   */
  app.post<{ Body: RegisterBody }>(
    "/v1/repos",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 1000 }, url: { type: "string", minLength: 1, maxLength: 1000 }, key: KEY, token: TOKEN },
          oneOf: [
            { required: ["path"], not: { anyOf: [{ required: ["url"] }, { required: ["token"] }] } },
            { required: ["url"], not: { required: ["path"] } },
          ],
        },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return;
      if ("url" in req.body) return registerUrl(req.body, reply);
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
      // Re-registering a path repo updates it; a URL repo's key is taken.
      const { rows } = await pool.query<{ inserted: boolean }>(
        `insert into repos (key, local_path, remote_url, default_branch) values ($1, $2, $3, $4)
         on conflict (key) do update set local_path = $2, remote_url = coalesce($3, repos.remote_url),
                                         default_branch = $4
         where repos.source = 'path'
         returning (xmax = 0) as inserted`,
        [key, info.toplevel, info.remoteUrl, info.branch],
      );
      if (!rows[0]) return reply.code(409).send({ error: `repo ${key} is already registered by URL` });
      return reply.code(rows[0].inserted ? 201 : 200).send({
        repo: { key, source: "path", host_path: hostPathOf(info.toplevel, deps.roots), remote_url: info.remoteUrl, default_branch: info.branch },
      });
    },
  );

  async function registerUrl(body: { url: string; key?: string; token?: string }, reply: FastifyReply) {
    let url: string;
    try {
      url = parseCloneUrl(body.url, { allowFile: deps.allowFileUrls });
    } catch (err) {
      if (err instanceof RepoError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    const key = body.key ?? repoKeyFromRemote(url);
    if (!key) return reply.code(400).send({ error: "can't derive a key from the URL; pass key (e.g. gh/owner/repo)" });
    const dest = path.resolve(clonesRoot, key);
    if (key.split("/").some((s) => s === "." || s === "..") || !dest.startsWith(path.resolve(clonesRoot) + path.sep)) {
      return reply.code(400).send({ error: `invalid key: ${key}` });
    }
    const taken = await pool.query<{ source: string }>("select source from repos where key = $1", [key]);
    if (taken.rows[0]) return reply.code(409).send({ error: `repo ${key} is already registered (by ${taken.rows[0].source})` });
    if (body.token && !deps.secretKey) return reply.code(503).send({ error: NO_SECRET_KEY });
    const token = body.token ?? null;

    // No row has this key, so anything at dest is left over from an earlier failed registration.
    if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
    let info;
    try {
      await cloneRepo(url, dest, clonesRoot, token);
      info = await inspectRepo(dest);
      const { rows } = await pool.query(
        `insert into repos (key, source, clone_url, token_enc, local_path, remote_url, default_branch, last_fetched_at)
         values ($1, 'url', $2, $3, $4, $2, $5, now())
         on conflict (key) do nothing returning key`,
        [key, url, token ? encryptSecret(token, deps.secretKey!) : null, dest, info.branch],
      );
      if (!rows[0]) return reply.code(409).send({ error: `repo ${key} is already registered` });
    } catch (err) {
      await rm(dest, { recursive: true, force: true });
      if (err instanceof RepoError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return reply.code(201).send({
      repo: { key, source: "url", url, has_token: !!token, host_path: null, remote_url: url, default_branch: info.branch },
    });
  }

  /** Replace a URL repo's token (write-only: it is never returned). */
  app.put<{ Params: { key: string }; Body: { token: string } }>(
    "/v1/repos/:key/token",
    {
      schema: {
        params: keyParams,
        body: { type: "object", additionalProperties: false, required: ["token"], properties: { token: TOKEN } },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return;
      if (!deps.secretKey) return reply.code(503).send({ error: NO_SECRET_KEY });
      const { rows } = await pool.query<{ source: string }>("select source from repos where key = $1", [req.params.key]);
      if (!rows[0]) return reply.code(404).send({ error: `no repo ${req.params.key}` });
      if (rows[0].source !== "url") return reply.code(400).send({ error: `repo ${req.params.key} is registered by path; it has no token` });
      await pool.query("update repos set token_enc = $2 where key = $1", [req.params.key, encryptSecret(req.body.token, deps.secretKey)]);
      return { repo: { key: req.params.key, has_token: true } };
    },
  );

  /**
   * Unregister a repo: its row, indexed docs and team links go; facts and commit episodes stay. A URL
   * repo's clone is removed too (only when it is inside the clones root).
   */
  app.delete<{ Params: { key: string } }>("/v1/repos/:key", { schema: { params: keyParams } }, async (req, reply) => {
    if (!curatorOnly(req, reply)) return;
    const key = req.params.key;
    const client = await pool.connect();
    let repo: { source: string; local_path: string | null } | undefined;
    try {
      await client.query("begin");
      await client.query("delete from team_repos where repo_key = $1", [key]);
      await client.query("delete from doc_chunks where repo_key = $1", [key]); // no FK to repos
      ({ rows: [repo] } = await client.query<{ source: string; local_path: string | null }>("delete from repos where key = $1 returning source, local_path", [key]));
      await client.query(repo ? "commit" : "rollback");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    if (!repo) return reply.code(404).send({ error: `no repo ${key}` });
    if (repo.source === "url" && repo.local_path && (await isUnder(repo.local_path, clonesRoot))) {
      await rm(repo.local_path, { recursive: true, force: true });
    }
    return { deleted: key };
  });

  app.get("/v1/repos", async () => {
    // Anchors of live facts per repo. The repo key expression must match verifyAnchors (jobs/verify.ts).
    const { rows } = await pool.query(
      `with anchor_counts as (
         select coalesce(a.repo_key, case when f.scope like 'repo:%' then substr(f.scope, 6) end) as repo,
                count(*) filter (where a.verify_status = 'verified')::int as verified,
                count(*) filter (where a.verify_status = 'drifted')::int as drifted,
                count(*) filter (where a.verify_status = 'missing')::int as missing,
                count(*) filter (where a.verify_status = 'unverifiable_here')::int as unverifiable_here,
                count(*) filter (where a.verify_status = 'unverified')::int as unverified
         from anchors a join facts f on f.id = a.fact_id
         where f.status in ('active', 'candidate')
         group by 1
       )
       select r.key, r.source, r.clone_url as url, (r.token_enc is not null) as has_token, r.last_fetched_at,
              r.local_path, r.remote_url, r.default_branch, r.last_ingested_sha, r.last_ingested_at,
              r.ingest_summary, r.ingest_error,
              (select count(*)::int from doc_files d where d.repo_key = r.key and d.status = 'indexed') as docs,
              (select count(*)::int from doc_chunks c where c.repo_key = r.key) as chunks,
              (select count(*)::int from episodes e where e.kind = 'commit' and e.repo_key = r.key) as commits,
              json_build_object('verified', coalesce(ac.verified, 0), 'drifted', coalesce(ac.drifted, 0),
                                'missing', coalesce(ac.missing, 0), 'unverifiable_here', coalesce(ac.unverifiable_here, 0),
                                'unverified', coalesce(ac.unverified, 0)) as anchors
       from repos r left join anchor_counts ac on ac.repo = r.key
       order by r.key`,
    );
    return {
      repos: rows.map(({ local_path, ...r }) => ({
        ...r,
        host_path: local_path && r.source === "path" ? hostPathOf(local_path, deps.roots) : null,
      })),
    };
  });

  /** Every repo key there is: registered repos and the repo scopes of active or candidate facts. */
  app.get("/v1/repo-keys", async () => {
    const { rows } = await pool.query<{ key: string }>(
      `select key from (
         select key from repos
         union
         select substr(scope, 6) from facts where scope like 'repo:%' and status in ('active', 'candidate')
       ) k order by key collate "C"`,
    );
    return { repo_keys: rows.map((r) => r.key) };
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
