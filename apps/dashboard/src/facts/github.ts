const GITHUB_REMOTE = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/** A github.com blob link for an anchor, or null when the remote isn't GitHub or the sha/path is missing. */
export function githubBlobUrl(
  remote_url: string | null | undefined,
  sha: string | null | undefined,
  path: string | null | undefined,
  a?: number | null,
  b?: number | null,
): string | null {
  if (!remote_url || !sha || !path) return null;
  const m = GITHUB_REMOTE.exec(remote_url.trim());
  if (!m) return null;
  const file = path.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  const lines = a ? (!b || b === a ? `#L${a}` : `#L${a}-L${b}`) : "";
  return `https://github.com/${m[1]}/${m[2]}/blob/${sha}/${file}${lines}`;
}
