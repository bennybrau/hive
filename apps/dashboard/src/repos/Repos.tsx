import { useCallback, useEffect, useState } from "react";
import { apiFetch, type Role } from "../api";
import { timeAgo } from "../review/Review";

export type AnchorStatus = "verified" | "drifted" | "missing" | "unverifiable_here" | "unverified";

export interface Repo {
  key: string;
  host_path: string | null;
  remote_url: string | null;
  default_branch: string | null;
  last_ingested_sha: string | null;
  last_ingested_at: string | null;
  ingest_error: string | null;
  docs: number;
  chunks: number;
  commits: number;
  anchors: Record<AnchorStatus, number>;
}

interface DocFile {
  path: string;
  status: "indexed" | "empty" | "skipped" | "error";
  note: string | null;
}

interface SyncResult {
  ingest: {
    docs: { indexed: number; unchanged: number; empty: number; skipped: number; error: number; removed: number };
    chunks_written: number;
    commits_added: number;
  };
  verify: { checked: number; verified: number; drifted: number; missing: number; unverifiable_here: number; retracted: number };
}

const ANCHOR_LABELS: [AnchorStatus, string][] = [
  ["verified", "verified"],
  ["drifted", "drifted"],
  ["missing", "missing"],
  ["unverifiable_here", "unverifiable here"],
  ["unverified", "unverified"],
];

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The hive answered ${res.status}.`;
}

function Files({ repoKey }: { repoKey: string }) {
  const [files, setFiles] = useState<DocFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    apiFetch(`/v1/repos/files?key=${encodeURIComponent(repoKey)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorOf(res));
        return ((await res.json()) as { files: DocFile[] }).files;
      })
      .then((f) => live && setFiles(f))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load files."));
    return () => {
      live = false;
    };
  }, [repoKey]);

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!files) return <p className="help">Loading files…</p>;
  const skipped = files.filter((f) => f.status !== "indexed");
  if (skipped.length === 0) return <p className="help">All files indexed.</p>;
  return (
    <table className="repos-files" aria-label={`Files not indexed in ${repoKey}`}>
      <thead>
        <tr>
          <th>Path</th>
          <th>Status</th>
          <th>Why</th>
        </tr>
      </thead>
      <tbody>
        {skipped.map((f) => (
          <tr key={f.path}>
            <td>
              <code>{f.path}</code>
            </td>
            <td>{f.status}</td>
            <td>{f.note ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function summary(r: SyncResult): string {
  const d = r.ingest.docs;
  const v = r.verify;
  return (
    `Ingested: ${d.indexed} docs indexed, ${d.unchanged} unchanged, ${d.removed} removed, ` +
    `${r.ingest.chunks_written} chunks, ${r.ingest.commits_added} new commits. ` +
    `Verified ${v.checked} anchors: ${v.verified} verified, ${v.drifted} drifted, ${v.missing} missing, ` +
    `${v.unverifiable_here} unverifiable here, ${v.retracted} facts retracted.`
  );
}

function RepoItem({ repo, curator, onIngested }: { repo: Repo; curator: boolean; onIngested: () => void }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function ingest() {
    setRunning(true);
    setResult(null);
    try {
      const res = await apiFetch("/v1/repos/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: repo.key }),
      });
      if (res.ok) {
        setResult({ ok: true, text: summary((await res.json()) as SyncResult) });
        onIngested();
      } else if (res.status === 409) {
        setResult({ ok: false, text: "An ingest of this repo is already running." });
      } else {
        setResult({ ok: false, text: await errorOf(res) });
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "Couldn't ingest." });
    } finally {
      setRunning(false);
    }
  }

  const filesId = `repo-files-${repo.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  return (
    <li data-key={repo.key}>
      <div className="repos-head">
        <h2>{repo.key}</h2>
        {repo.host_path && <code className="repos-path">{repo.host_path}</code>}
      </div>
      <p className="repos-meta">
        {repo.last_ingested_at ? (
          <>
            Ingested <time dateTime={repo.last_ingested_at}>{timeAgo(repo.last_ingested_at)}</time>
            {repo.last_ingested_sha && (
              <>
                {" "}
                at <code>{repo.last_ingested_sha.slice(0, 7)}</code>
              </>
            )}
          </>
        ) : (
          "Not ingested yet"
        )}
        <span>
          {repo.docs} docs, {repo.chunks} chunks, {repo.commits} commits
        </span>
      </p>
      <p className="repos-anchors" aria-label="Anchor health">
        {ANCHOR_LABELS.map(([s, label]) => (
          <span key={s} className={`badge verify-${s}`}>
            {repo.anchors[s]} {label}
          </span>
        ))}
      </p>
      {repo.ingest_error && <p className="error">Last ingest failed: {repo.ingest_error}</p>}
      <div className="repos-actions">
        <button type="button" aria-expanded={open} aria-controls={filesId} onClick={() => {
            setOpen(!open);
            setLoaded(true);
          }}>
          Files not indexed
        </button>
        {curator && (
          <button type="button" disabled={running} onClick={() => void ingest()}>
            {running ? "Ingesting…" : "Ingest now"}
          </button>
        )}
      </div>
      {result && (
        <p className={result.ok ? "help" : "error"} role={result.ok ? "status" : "alert"}>
          {result.text}
        </p>
      )}
      {/* Mounted on first open and then only hidden, so the files are fetched once. */}
      <div id={filesId} className="repos-files-wrap" hidden={!open}>
        {loaded && <Files repoKey={repo.key} />}
      </div>
    </li>
  );
}

/** /repos: every registered repo, its ingest state and anchor health. */
export function Repos({ role }: { role: Role }) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    apiFetch("/v1/repos")
      .then(async (res) => {
        if (!res.ok) throw new Error(`The hive answered ${res.status}.`);
        return ((await res.json()) as { repos: Repo[] }).repos;
      })
      .then((r) => {
        if (!live) return;
        setRepos(r);
        setError(null);
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : "Couldn't load repos."));
    return () => {
      live = false;
    };
  }, []);
  useEffect(load, [load]);

  return (
    <main className="page repos-page">
      <h1>Repos</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!repos && !error && <p className="help">Loading repos…</p>}
      {repos && repos.length === 0 && <p className="help">No repos registered yet. A curator registers one with POST /v1/repos.</p>}
      {repos && repos.length > 0 && (
        <ul className="repos-list">
          {repos.map((r) => (
            <RepoItem key={r.key} repo={r} curator={role === "curator"} onIngested={() => void load()} />
          ))}
        </ul>
      )}
    </main>
  );
}
