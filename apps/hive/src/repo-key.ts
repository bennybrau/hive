/**
 * git remote URL -> hive repo key. github.com/<o>/<r> -> gh/<o>/<r>; other hosts -> <host>/<path>.
 * The same rule as the Hermes plugin's repo_key_from_remote (plugins/hive/__init__.py); "" when it can't tell.
 */
export function repoKeyFromRemote(url: string): string {
  url = url.trim();
  if (!url) return "";
  let host: string;
  let path: string;
  const m = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(url); // scp-like: git@github.com:owner/repo.git
  if (m) {
    host = m[1]!;
    path = m[2]!;
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return "";
    }
  }
  path = path.replace(/^\/+|\/+$/g, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  if (!host || !path) return "";
  return host.toLowerCase() === "github.com" ? `gh/${path}` : `${host.toLowerCase()}/${path}`;
}
