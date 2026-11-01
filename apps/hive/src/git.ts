import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export class RepoError extends Error {}

/** Run git in a repo; stdout as text. Big buffer: ls-files and log on real repos are large. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return stdout;
}

/** git remote URL -> repo key. github.com/<o>/<r> -> gh/<o>/<r>; other hosts -> <host>/<path>. Same rule as the plugin. */
export function repoKeyFromRemote(url: string): string {
  const u = url.trim();
  if (!u) return "";
  let host: string;
  let p: string;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(u);
  if (scp) {
    host = scp[1]!;
    p = scp[2]!;
  } else {
    try {
      const parsed = new URL(u);
      host = parsed.hostname;
      p = parsed.pathname;
    } catch {
      return "";
    }
  }
  p = p.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || !p) return "";
  return host.toLowerCase() === "github.com" ? `gh/${p}` : `${host.toLowerCase()}/${p}`;
}

export interface RepoRoots {
  /** Where repos are visible to the service (in Docker: the read-only mount, /repos). */
  root: string;
  /** The same directory as the user sees it on the host (e.g. /Users/jon/dev), so they can register by host path. */
  hostRoot: string;
}

/**
 * Map what a user typed (a host path like /Users/jon/dev/asf, a path relative to the repos root, or a
 * path already under the root) to a real directory inside the root. Refuses anything outside it.
 */
export async function resolveRepoPath(input: string, roots: RepoRoots): Promise<string> {
  let candidate: string;
  if (path.isAbsolute(input)) {
    const host = path.resolve(roots.hostRoot);
    const abs = path.resolve(input);
    if (abs === host || abs.startsWith(host + path.sep)) candidate = path.join(roots.root, path.relative(host, abs));
    else candidate = abs;
  } else {
    candidate = path.join(roots.root, input);
  }
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new RepoError(`no such directory: ${input} (repos must live under ${roots.hostRoot})`);
  }
  const rootReal = await realpath(roots.root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new RepoError(`${input} is outside the repos root ${roots.hostRoot}`);
  }
  if (!(await stat(real)).isDirectory()) throw new RepoError(`${input} is not a directory`);
  return real;
}

/** For display: the host path of a directory under the root. */
export function hostPathOf(localPath: string, roots: RepoRoots): string {
  const rel = path.relative(roots.root, localPath);
  return rel.startsWith("..") ? localPath : path.join(roots.hostRoot, rel);
}

export interface RepoInfo {
  toplevel: string;
  remoteUrl: string | null;
  /** The branch ingest reads (see defaultBranch), not whatever the checkout happens to be on. */
  branch: string | null;
  /** Its tip commit. */
  head: string;
}

const verifyCommit = (dir: string, ref: string) =>
  git(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).then((s) => s.trim() || null, () => null);

/**
 * The commit a shared index should read: the default branch as last fetched from origin, so what
 * the hive serves (and links to) is what's on the remote, not a local feature branch or unpushed
 * work. Order: origin/HEAD, origin/main, origin/master, then local main/master (a repo with no
 * remote), then the checkout's own HEAD as a last resort. Read-only: never fetches.
 */
export async function defaultBranch(dir: string): Promise<{ branch: string | null; sha: string } | null> {
  const originHead = (await git(dir, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  const candidates: [string, string][] = [];
  if (originHead.startsWith("refs/remotes/origin/")) candidates.push([originHead, originHead.slice("refs/remotes/origin/".length)]);
  for (const b of ["main", "master"]) candidates.push([`refs/remotes/origin/${b}`, b]);
  for (const b of ["main", "master"]) candidates.push([`refs/heads/${b}`, b]);
  for (const [ref, branch] of candidates) {
    const sha = await verifyCommit(dir, ref);
    if (sha) return { branch, sha };
  }
  const sha = await verifyCommit(dir, "HEAD");
  if (!sha) return null;
  const cur = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  return { branch: cur && cur !== "HEAD" ? cur : null, sha };
}

export async function inspectRepo(dir: string): Promise<RepoInfo> {
  let toplevel: string;
  try {
    toplevel = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new RepoError(`${dir} is not a git repository`);
  }
  const tip = await defaultBranch(toplevel);
  if (!tip) throw new RepoError(`${dir} has no commits yet`);
  const remoteUrl = (await git(toplevel, ["remote", "get-url", "origin"]).catch(() => "")).trim() || null;
  return { toplevel, remoteUrl, branch: tip.branch, head: tip.sha };
}

/** Files in a commit's tree with their blob sha (`git ls-tree -r`). Paths are repo-relative, '/'-separated. */
export async function trackedFiles(dir: string, commit: string): Promise<{ path: string; blob: string }[]> {
  const out = await git(dir, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  return out
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(line);
      if (!m || m[2] !== "blob") return []; // submodules are `commit` entries
      return [{ path: m[4]!, blob: m[3]! }];
    });
}

export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: string[];
}

/** Non-merge commits reachable from `tip`, newest first: `since..tip` after a previous ingest, else the last `max`. */
export async function commitsSince(dir: string, since: string | null, max: number, tip: string): Promise<Commit[]> {
  const range = since ? [`${since}..${tip}`] : [tip];
  let out: string;
  try {
    out = await git(dir, ["log", "--no-merges", `-n${max}`, "--name-only", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f", ...range]);
  } catch {
    if (!since) throw new RepoError("git log failed");
    return commitsSince(dir, null, max, tip); // since-commit vanished (force push / rebase): fall back
  }
  return out
    .split("\x1e")
    .filter((r) => r.trim())
    .map((rec) => {
      const [sha, author, date, subject, body, rest] = rec.split("\x1f");
      return {
        sha: sha!.trim(),
        author: author ?? "",
        date: date ?? "",
        subject: subject ?? "",
        body: (body ?? "").trim(),
        files: (rest ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
      };
    });
}

/** Paths a client reports as changed, cleaned: repo-relative, no leading ./ or /, no '..'. */
export function cleanRelPath(p: string): string | null {
  const s = p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!s || s.split("/").includes("..")) return null;
  return s;
}
