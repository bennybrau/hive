/**
 * Verify: re-check every anchor's quote against its source, so facts can't silently rot.
 *
 *   verified           quote found in the file as it is now (if it moved, found_line says where)
 *   drifted            exact quote gone, but a close variant is there: the source was edited
 *   missing            file deleted, or nothing like the quote remains
 *   unverifiable_here  nothing to check against here (repo not registered, no path and no episode)
 *
 * Reads the working tree (what a developer sees right now), not HEAD. An `ingested` fact whose
 * every file anchor is missing is retracted: ground truth whose ground is gone.
 *
 * Files vanish briefly during normal work (`git checkout` deletes then rewrites), so a file that
 * looks deleted is re-checked once after `missingRetryMs`, and an ingested fact is only retracted
 * when its sources were already missing on the previous pass too.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { docKind, extractText } from "../extract.js";
import { cleanRelPath } from "../git.js";

export type VerifyStatus = "verified" | "drifted" | "missing" | "unverifiable_here";

export interface Located {
  status: Exclude<VerifyStatus, "unverifiable_here">;
  line: number | null;
  endLine: number | null;
  note: string;
}

const MAX_VERIFY_BYTES = 25 * 1024 * 1024;
const NEAR = 3; // lines a quote may move and still be "where we left it"
export const FUZZY_MIN = 0.6;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const tokens = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** Dice coefficient on token multisets. */
function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const n = counts.get(t) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(t, n - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/** Find a quote in a text. `hint` is the line it was last seen at (1-based) or null. */
export function locate(text: string, quote: string, hint: number | null): Located {
  const q = norm(quote);
  const lines = text.split("\n");
  const starts: number[] = [];
  const parts: string[] = [];
  let pos = 0;
  for (const l of lines) {
    const n = norm(l);
    starts.push(pos);
    parts.push(n);
    pos += n.length + 1;
  }
  const hay = parts.join(" ");
  const lineAt = (off: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  if (q) {
    // every exact occurrence; prefer the one nearest where we last saw it
    let best: { line: number; end: number } | null = null;
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + 1)) {
      const hit = { line: lineAt(i), end: lineAt(i + q.length - 1) };
      if (!best || (hint !== null && Math.abs(hit.line - hint) < Math.abs(best.line - hint))) best = hit;
      if (hint === null) break;
    }
    if (best) {
      const moved = hint !== null && Math.abs(best.line - hint) > NEAR;
      return { status: "verified", line: best.line, endLine: best.end, note: moved ? `moved from line ${hint} to ${best.line}` : "quote found" };
    }
  }

  // not verbatim: is there a close variant (an edited line)?
  const qt = tokens(quote);
  const qLines = Math.max(1, quote.trim().split("\n").length);
  let fuzzy = { score: 0, line: 0, end: 0 };
  for (const w of new Set([qLines, qLines + 1])) {
    for (let i = 0; i + w <= lines.length; i++) {
      const window = lines.slice(i, i + w).join(" ");
      if (!window.trim()) continue;
      const s = dice(qt, tokens(window));
      if (s > fuzzy.score) fuzzy = { score: s, line: i + 1, end: i + w };
    }
  }
  if (fuzzy.score >= FUZZY_MIN) {
    return { status: "drifted", line: fuzzy.line, endLine: fuzzy.end, note: `quote changed (${Math.round(fuzzy.score * 100)}% similar at line ${fuzzy.line})` };
  }
  return { status: "missing", line: null, endLine: null, note: "quote not found" };
}

interface AnchorRow {
  id: string;
  fact_id: string;
  episode_id: string | null;
  path: string | null;
  quote: string | null;
  line_start: number | null;
  local_path: string | null;
  repo: string | null;
  prev: string;
}

interface Outcome {
  status: VerifyStatus;
  line: number | null;
  endLine: number | null;
  note: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readForVerify(file: string, rel: string): Promise<string | Error> {
  try {
    const st = await stat(file);
    if (!st.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
    if (st.size > MAX_VERIFY_BYTES) throw new Error("too large to verify");
    const bytes = await readFile(file);
    return docKind(rel) && docKind(rel) !== "text" ? await extractText(rel, bytes) : bytes.toString("utf8");
  } catch (err) {
    return err as Error;
  }
}

const isGone = (e: unknown) => e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT";

async function check(pool: pg.Pool, a: AnchorRow, fileCache: Map<string, string | Error>, retryMs: number): Promise<Outcome> {
  if (!a.path) {
    if (a.episode_id && a.quote) {
      const { rows } = await pool.query<{ content: string }>("select content from episodes where id = $1", [a.episode_id]);
      if (!rows[0]) return { status: "missing", line: null, endLine: null, note: "episode purged" };
      const r = locate(rows[0].content, a.quote, a.line_start);
      return { ...r, note: r.status === "verified" ? "quote found in conversation" : r.note };
    }
    return { status: "unverifiable_here", line: null, endLine: null, note: "no file or conversation to check" };
  }
  if (!a.local_path) {
    return { status: "unverifiable_here", line: null, endLine: null, note: a.repo ? `repo ${a.repo} not registered` : "no repo for this anchor" };
  }
  const rel = cleanRelPath(a.path);
  if (!rel) return { status: "unverifiable_here", line: null, endLine: null, note: "invalid path" };
  const file = path.join(a.local_path, rel);
  if (!file.startsWith(a.local_path + path.sep)) return { status: "unverifiable_here", line: null, endLine: null, note: "invalid path" };

  let text = fileCache.get(file);
  if (text === undefined) {
    text = await readForVerify(file, rel);
    if (isGone(text) && retryMs > 0) {
      await sleep(retryMs); // mid-checkout? look again before calling it deleted
      text = await readForVerify(file, rel);
    }
    fileCache.set(file, text);
  }
  if (text instanceof Error) {
    if (isGone(text)) return { status: "missing", line: null, endLine: null, note: "file deleted" };
    return { status: "unverifiable_here", line: null, endLine: null, note: text.message.split("\n")[0]! };
  }
  if (!a.quote) return { status: "verified", line: null, endLine: null, note: "file exists" };
  return locate(text, a.quote, a.line_start);
}

export interface VerifySummary {
  checked: number;
  verified: number;
  drifted: number;
  missing: number;
  unverifiable_here: number;
  retracted: number;
  ms: number;
}

/** Check anchors of live facts (active + candidate), optionally only one repo's or a few facts'. */
export async function verifyAnchors(
  pool: pg.Pool,
  opts: { repoKey?: string; factIds?: string[]; missingRetryMs?: number } = {},
): Promise<VerifySummary> {
  const t0 = Date.now();
  const where = ["f.status in ('active', 'candidate')"];
  const params: unknown[] = [];
  if (opts.repoKey) {
    params.push(opts.repoKey);
    where.push(`coalesce(a.repo_key, case when f.scope like 'repo:%' then substr(f.scope, 6) end) = $${params.length}`);
  }
  if (opts.factIds) {
    params.push(opts.factIds);
    where.push(`a.fact_id = any($${params.length})`);
  }
  const { rows } = await pool.query<AnchorRow>(
    `select a.id, a.fact_id, a.episode_id, a.path, a.quote, a.line_start, r.local_path, a.verify_status as prev,
            coalesce(a.repo_key, case when f.scope like 'repo:%' then substr(f.scope, 6) end) as repo
     from anchors a
     join facts f on f.id = a.fact_id
     left join repos r on r.key = coalesce(a.repo_key, case when f.scope like 'repo:%' then substr(f.scope, 6) end)
     where ${where.join(" and ")}`,
    params,
  );
  const summary: VerifySummary = { checked: 0, verified: 0, drifted: 0, missing: 0, unverifiable_here: 0, retracted: 0, ms: 0 };
  const cache = new Map<string, string | Error>();
  const retryMs = opts.missingRetryMs ?? 1000;
  const missingTwice: string[] = []; // anchors missing on this pass AND the previous one
  for (const a of rows) {
    const r = await check(pool, a, cache, retryMs);
    if (r.status === "missing" && a.prev === "missing") missingTwice.push(a.id);
    summary.checked++;
    summary[r.status]++;
    await pool.query(
      `update anchors set verify_status = $2, verify_note = $3, found_line = $4, verified_at = now(),
              line_start = case when $2 = 'verified' then coalesce(line_start, $4) else line_start end,
              line_end   = case when $2 = 'verified' then coalesce(line_end, $5) else line_end end
       where id = $1`,
      [a.id, r.status, r.note, r.line, r.endLine],
    );
  }
  // ground truth whose ground is gone: every file anchor missing, on two passes in a row
  const retracted = await pool.query(
    `update facts f set status = 'retracted', valid_to = now(), expired_at = now(),
            status_note = 'source gone: ' || (select string_agg(a.path, ', ') from anchors a where a.fact_id = f.id and a.path is not null)
     where f.origin = 'ingested' and f.status = 'active'
       and exists (select 1 from anchors a where a.fact_id = f.id and a.path is not null)
       and not exists (select 1 from anchors a where a.fact_id = f.id and a.path is not null and not (a.id = any($1)))`,
    [missingTwice],
  );
  summary.retracted = retracted.rowCount ?? 0;
  summary.ms = Date.now() - t0;
  return summary;
}
