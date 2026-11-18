import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, type Role } from "../api";
import { EmptyState, Field, PageHeader } from "../ui";
import { PHRASE, VERIFY, when } from "../words";

export type AnchorStatus = "verified" | "drifted" | "missing" | "unverifiable_here" | "unverified";

export interface Repo {
  key: string;
  source: "path" | "url";
  url: string | null;
  has_token: boolean;
  last_fetched_at: string | null;
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

const NO_SECRET_KEY = "Hive can't store tokens: HIVE_SECRET_KEY is not set on the server.";

const ANCHOR_STATES: AnchorStatus[] = ["verified", "drifted", "missing", "unverifiable_here", "unverified"];

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
    `Read: ${d.indexed} docs indexed, ${d.unchanged} unchanged, ${d.removed} removed, ` +
    `${r.ingest.chunks_written} chunks, ${r.ingest.commits_added} new commits. ` +
    `Checked ${v.checked} quotes: ${v.verified} ${VERIFY.verified!.label}, ${v.drifted} ${VERIFY.drifted!.label}, ` +
    `${v.missing} ${VERIFY.missing!.label}, ${v.unverifiable_here} ${VERIFY.unverifiable_here!.label}, ${v.retracted} facts retired.`
  );
}

function AddByUrl({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: { url: string; key?: string; token?: string } = { url: url.trim() };
    if (key.trim()) body.key = key.trim();
    if (token) body.token = token;
    setToken("");
    try {
      const res = await apiFetch("/v1/repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 201) {
        setUrl("");
        setKey("");
        onAdded();
      } else if (res.status === 409) {
        setError("That key is already registered.");
      } else if (res.status === 503) {
        setError(NO_SECRET_KEY);
      } else {
        setError(await errorOf(res));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the repo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="repos-add" onSubmit={(e) => void submit(e)}>
      <h2>Add by URL</h2>
      <div className="repos-add-fields">
        <Field label="GitHub URL">
          {(p) => <input {...p} type="url" required value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} />}
        </Field>
        <Field label="Key (optional)" help="Defaults to gh/owner/repo">
          {(p) => <input {...p} type="text" value={key} disabled={busy} onChange={(e) => setKey(e.target.value)} />}
        </Field>
        <Field label="Access token (optional, for private repos)">
          {(p) => (
            <input {...p} type="password" autoComplete="off" value={token} disabled={busy} onChange={(e) => setToken(e.target.value)} />
          )}
        </Field>
      </div>
      <div className="repos-actions">
        <button type="submit" disabled={busy}>
          {busy ? "Cloning…" : "Add repo"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function RepoItem({ repo, curator, onIngested }: { repo: Repo; curator: boolean; onIngested: () => void }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);

  async function saveToken() {
    const token = newToken ?? "";
    setNewToken("");
    setBusy(true);
    setResult(null);
    try {
      const res = await apiFetch(`/v1/repos/${encodeURIComponent(repo.key)}/token`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setNewToken(null);
        onIngested();
      } else {
        setResult({ ok: false, text: res.status === 503 ? NO_SECRET_KEY : await errorOf(res) });
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "Couldn't save the token." });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setResult(null);
    try {
      const res = await apiFetch(`/v1/repos/${encodeURIComponent(repo.key)}`, { method: "DELETE" });
      if (res.ok) {
        onIngested();
      } else {
        setRemoving(false);
        setResult({ ok: false, text: await errorOf(res) });
      }
    } catch (err) {
      setRemoving(false);
      setResult({ ok: false, text: err instanceof Error ? err.message : "Couldn't remove the repo." });
    } finally {
      setBusy(false);
    }
  }

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
        setResult({ ok: false, text: "Hive is already reading this repo." });
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
      </div>
      <div className="repos-meta">
        {repo.source === "url" ? (
          <>
            <span>
              Cloned from <code>{repo.url}</code>
            </span>
            {repo.has_token && <span>token set</span>}
            {repo.last_fetched_at ? (
              <span>
                Fetched{" "}
                <time dateTime={repo.last_fetched_at} title={when(repo.last_fetched_at).title}>
                  {when(repo.last_fetched_at).text}
                </time>
              </span>
            ) : (
              <span>Not fetched yet</span>
            )}
          </>
        ) : (
          <div className="repos-source">
            Folder on this machine
            {repo.host_path && (
              <details className="repos-path">
                <summary>Where it is on disk</summary>
                <code>{repo.host_path}</code>
              </details>
            )}
          </div>
        )}
        {repo.last_ingested_at ? (
          <>
            Read{" "}
            <time dateTime={repo.last_ingested_at} title={when(repo.last_ingested_at).title}>
              {when(repo.last_ingested_at).text}
            </time>
            {repo.last_ingested_sha && (
              <>
                {" "}
                at <code>{repo.last_ingested_sha.slice(0, 7)}</code>
              </>
            )}
          </>
        ) : (
          "Not read yet"
        )}
        <span>
          {repo.docs} docs, {repo.chunks} chunks, {repo.commits} commits
        </span>
      </div>
      <p className="repos-anchors" aria-label="Anchor health">
        {ANCHOR_STATES.map((s) => (
          <span key={s} className={`badge verify-${s}`} title={VERIFY[s]!.hint || undefined}>
            {repo.anchors[s]} {VERIFY[s]!.label}
          </span>
        ))}
      </p>
      {repo.ingest_error && <p className="error">Last read failed: {repo.ingest_error}</p>}
      {removing ? (
        <div className="repos-actions">
          <span>Remove {repo.key}? Its indexed docs and clone are deleted; facts stay.</span>
          <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
            Yes
          </button>
          <button type="button" disabled={busy} onClick={() => setRemoving(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="repos-actions">
          <button type="button" aria-expanded={open} aria-controls={filesId} onClick={() => {
              setOpen(!open);
              setLoaded(true);
            }}>
            Files not indexed
          </button>
          {curator && (
            <button type="button" disabled={running} onClick={() => void ingest()}>
              {running ? PHRASE.ingesting : PHRASE.ingestNow}
            </button>
          )}
          {curator && repo.source === "url" && (
            <>
              <button type="button" aria-expanded={newToken !== null} onClick={() => setNewToken(newToken === null ? "" : null)}>
                Replace token
              </button>
              <button type="button" onClick={() => setRemoving(true)}>
                Remove
              </button>
            </>
          )}
        </div>
      )}
      {newToken !== null && !removing && (
        <form
          className="repos-token"
          onSubmit={(e) => {
            e.preventDefault();
            void saveToken();
          }}
        >
          <Field label="New access token">
            {(p) => (
              <input {...p} type="password" autoComplete="off" required value={newToken} disabled={busy} onChange={(e) => setNewToken(e.target.value)} />
            )}
          </Field>
          <div className="repos-actions">
            <button type="submit" disabled={busy}>
              Save
            </button>
            <button type="button" disabled={busy} onClick={() => setNewToken(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
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
      <PageHeader title="Sources" lede="The repos Hive reads, and whether what it learned from them still matches." />
      {role === "curator" && <AddByUrl onAdded={() => void load()} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!repos && !error && <p className="help">Loading repos…</p>}
      {repos && repos.length === 0 && (
        <EmptyState title="No repos yet">
          A curator adds a repo by its GitHub URL, or by pointing Hive at its checkout; Hive then reads its docs and commits.{" "}
          <span className="help">
            (Through the API: <code>POST /v1/repos</code>.)
          </span>
        </EmptyState>
      )}
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
