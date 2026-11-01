/**
 * Ingest a registered repo: its documents (README, docs/, markdown anywhere, plus PDF/Word/
 * PowerPoint/Excel under docs/) into searchable chunks, and its commit messages as episodes.
 * Incremental: a file whose git blob hasn't changed since the last ingest is skipped, and only
 * commits after the last ingested tip are read. Content is read from git at the default branch's
 * tip (see defaultBranch: origin's default as last fetched), not the working tree or the branch
 * the checkout is on, so half-saved edits and feature branches never get indexed and doc links
 * point at commits the remote has.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type pg from "pg";
import { chunkText } from "../chunk.js";
import { docKind, extractText, ExtractError, MAX_DOC_BYTES } from "../extract.js";
import { commitsSince, git, inspectRepo, RepoError, trackedFiles } from "../git.js";

const run = promisify(execFile);

/** Directories never worth indexing even if someone committed them. */
const IGNORED_DIRS = new Set(["node_modules", "vendor", "third_party", ".venv", "venv", "dist", "build", ".next", "coverage"]);
const ROOT_OR_DOCS = (segs: string[]) => segs.length === 1 || segs.slice(0, -1).some((s) => /^docs?$/i.test(s));

/** Which tracked files are documents we index. */
export function isIndexedDoc(path: string): boolean {
  const kind = docKind(path);
  if (!kind) return false;
  const segs = path.split("/");
  if (segs.some((s) => IGNORED_DIRS.has(s))) return false;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (kind === "text") return [".md", ".mdx", ".markdown"].includes(ext) || ROOT_OR_DOCS(segs);
  return ROOT_OR_DOCS(segs); // PDF / Office: repo root or a docs/ folder, not test fixtures and assets
}

export interface IngestSummary {
  head: string;
  docs: { indexed: number; unchanged: number; empty: number; skipped: number; error: number; removed: number };
  chunks_written: number;
  commits_added: number;
  ms: number;
}

async function blobBytes(dir: string, blob: string): Promise<Buffer> {
  const { stdout } = await run("git", ["-C", dir, "cat-file", "blob", blob], { encoding: "buffer", maxBuffer: MAX_DOC_BYTES + 1024 });
  return stdout;
}

export async function ingestRepo(pool: pg.Pool, key: string, opts: { maxCommits: number }): Promise<IngestSummary> {
  const t0 = Date.now();
  const { rows } = await pool.query<{ local_path: string | null; last_ingested_sha: string | null }>(
    "select local_path, last_ingested_sha from repos where key = $1",
    [key],
  );
  const repo = rows[0];
  if (!repo) throw new RepoError(`unknown repo ${key}`);
  if (!repo.local_path) throw new RepoError(`repo ${key} has no local path`);
  const dir = repo.local_path;
  const info = await inspectRepo(dir);

  const summary: IngestSummary = {
    head: info.head,
    docs: { indexed: 0, unchanged: 0, empty: 0, skipped: 0, error: 0, removed: 0 },
    chunks_written: 0,
    commits_added: 0,
    ms: 0,
  };

  // --- documents ---------------------------------------------------------------
  const docs = (await trackedFiles(dir, info.head)).filter((f) => isIndexedDoc(f.path));
  const known = new Map(
    (await pool.query<{ path: string; blob_sha: string }>("select path, blob_sha from doc_files where repo_key = $1", [key])).rows.map(
      (r) => [r.path, r.blob_sha],
    ),
  );
  for (const f of docs) {
    if (known.get(f.path) === f.blob) {
      summary.docs.unchanged++;
      continue;
    }
    let status: "indexed" | "empty" | "skipped" | "error" = "indexed";
    let note: string | null = null;
    let chunks: ReturnType<typeof chunkText> = [];
    try {
      const size = Number((await git(dir, ["cat-file", "-s", f.blob])).trim());
      if (size > MAX_DOC_BYTES) {
        status = "skipped";
        note = `too large (${Math.round(size / 1048576)} MB > ${MAX_DOC_BYTES / 1048576} MB)`;
      } else {
        const text = await extractText(f.path, await blobBytes(dir, f.blob));
        chunks = chunkText(text);
        if (!chunks.length) {
          status = "empty";
          note = docKind(f.path) === "pdf" ? "no text layer (scanned PDF?)" : "no text";
        }
      }
    } catch (err) {
      status = "error";
      note = err instanceof ExtractError ? err.message : `read failed: ${(err as Error).message.split("\n")[0]}`;
    }
    summary.docs[status]++;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from doc_chunks where repo_key = $1 and path = $2", [key, f.path]);
      for (const c of chunks) {
        await client.query(
          `insert into doc_chunks (repo_key, path, chunk_index, content, sha, line_start, line_end)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [key, f.path, c.index, c.content, f.blob, c.lineStart, c.lineEnd],
        );
      }
      await client.query(
        `insert into doc_files (repo_key, path, blob_sha, status, note, chunks, ingested_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (repo_key, path) do update set blob_sha = $3, status = $4, note = $5, chunks = $6, ingested_at = now()`,
        [key, f.path, f.blob, status, note, chunks.length],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    summary.chunks_written += chunks.length;
  }
  const current = new Set(docs.map((d) => d.path));
  const gone = [...known.keys()].filter((p) => !current.has(p));
  if (gone.length) {
    await pool.query("delete from doc_chunks where repo_key = $1 and path = any($2)", [key, gone]);
    await pool.query("delete from doc_files where repo_key = $1 and path = any($2)", [key, gone]);
    summary.docs.removed = gone.length;
  }

  // --- commits -----------------------------------------------------------------
  const commits = repo.last_ingested_sha === info.head ? [] : await commitsSince(dir, repo.last_ingested_sha, opts.maxCommits, info.head);
  for (const c of commits) {
    const files = c.files.slice(0, 50);
    const content = [c.subject, c.body, files.length ? `Files: ${files.join(", ")}${c.files.length > 50 ? ` (+${c.files.length - 50} more)` : ""}` : ""]
      .filter(Boolean)
      .join("\n\n");
    const res = await pool.query(
      `insert into episodes (kind, repo_key, ref, content, metadata)
       values ('commit', $1, $2, $3, $4)
       on conflict (repo_key, ref) where kind = 'commit' do nothing`,
      [key, c.sha, content, { author: c.author, date: c.date, files: c.files.length }],
    );
    summary.commits_added += res.rowCount ?? 0;
  }

  summary.ms = Date.now() - t0;
  await pool.query(
    `update repos set last_ingested_sha = $2, last_ingested_at = now(), default_branch = $3,
            remote_url = coalesce($4, remote_url), ingest_summary = $5, ingest_error = null
     where key = $1`,
    [key, info.head, info.branch, info.remoteUrl, summary],
  );
  return summary;
}
