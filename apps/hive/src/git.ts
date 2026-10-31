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
  branch: string | null;
  head: string;
}

export async function inspectRepo(dir: string): Promise<RepoInfo> {
  let toplevel: string;
  try {
    toplevel = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new RepoError(`${dir} is not a git repository`);
  }
  const head = (await git(toplevel, ["rev-parse", "HEAD"]).catch(() => "")).trim();
  if (!head) throw new RepoError(`${dir} has no commits yet`);
  const remoteUrl = (await git(toplevel, ["remote", "get-url", "origin"]).catch(() => "")).trim() || null;
  const branch = (await git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() || null;
  return { toplevel, remoteUrl, branch: branch === "HEAD" ? null : branch, head };
}

/** Tracked files with their blob sha (`git ls-files -s`). Paths are repo-relative, '/'-separated. */
export async function trackedFiles(dir: string): Promise<{ path: string; blob: string }[]> {
  const out = await git(dir, ["ls-files", "-s", "-z"]);
  return out
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      const m = /^(\d+) ([0-9a-f]+) \d+\t(.+)$/s.exec(line);
      if (!m || m[1] === "160000") return []; // submodules
      return [{ path: m[3]!, blob: m[2]! }];
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

/** Non-merge commits, newest first: `since..HEAD` when we have a previous ingest, else the last `max`. */
export async function commitsSince(dir: string, since: string | null, max: number): Promise<Commit[]> {
  const range = since ? [`${since}..HEAD`] : ["HEAD"];
  let out: string;
  try {
    out = await git(dir, ["log", "--no-merges", `-n${max}`, "--name-only", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f", ...range]);
  } catch {
    if (!since) throw new RepoError("git log failed");
    return commitsSince(dir, null, max); // since-commit vanished (force push / rebase): fall back
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
