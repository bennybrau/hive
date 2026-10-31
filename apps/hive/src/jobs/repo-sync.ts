/**
 * Keeps registered repos current: ingest (incremental) then verify, for one repo on demand or all
 * repos on a timer. One run per repo at a time; a second request while one runs gets RepoBusyError.
 */
import type pg from "pg";
import { ingestRepo, type IngestSummary } from "./ingest.js";
import { verifyAnchors, type VerifySummary } from "./verify.js";

export class RepoBusyError extends Error {}

export interface SyncResult {
  key: string;
  ingest: IngestSummary;
  verify: VerifySummary;
}

export interface RepoSync {
  sync(key: string): Promise<SyncResult>;
  syncAll(): Promise<(SyncResult | { key: string; error: string })[]>;
  stop(): Promise<void>;
}

export function createRepoSync(
  pool: pg.Pool,
  opts: { maxCommits: number; intervalMin: number; onWrite?: () => void; log?: (m: string) => void },
): RepoSync {
  const log = opts.log ?? ((m: string) => console.error(m));
  const running = new Map<string, Promise<SyncResult>>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let all: Promise<unknown> | null = null;

  async function sync(key: string): Promise<SyncResult> {
    if (running.has(key)) throw new RepoBusyError(`repo ${key} is already being ingested`);
    const p = (async () => {
      try {
        const ingest = await ingestRepo(pool, key, { maxCommits: opts.maxCommits });
        opts.onWrite?.();
        const verify = await verifyAnchors(pool, { repoKey: key });
        return { key, ingest, verify };
      } catch (err) {
        await pool.query("update repos set ingest_error = $2 where key = $1", [key, (err as Error).message]).catch(() => {});
        throw err;
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, p);
    return p;
  }

  async function syncAll() {
    const { rows } = await pool.query<{ key: string }>("select key from repos where local_path is not null order by key");
    const out: (SyncResult | { key: string; error: string })[] = [];
    for (const { key } of rows) {
      if (stopped) break;
      try {
        out.push(await sync(key));
      } catch (err) {
        if (!(err instanceof RepoBusyError)) log(`repo sync ${key}: ${(err as Error).message}`);
        out.push({ key, error: (err as Error).message });
      }
    }
    // facts with no repo anchors (conversation quotes) are checked too
    await verifyAnchors(pool).catch((err) => log(`verify: ${(err as Error).message}`));
    return out;
  }

  const tick = () => {
    if (stopped) return;
    all = syncAll()
      .catch((err) => log(`repo sync: ${(err as Error).message}`))
      .finally(() => {
        all = null;
        if (!stopped) timer = setTimeout(tick, opts.intervalMin * 60_000);
      });
  };
  if (opts.intervalMin > 0) timer = setTimeout(tick, 10_000); // first pass shortly after boot

  return {
    sync,
    syncAll,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await all;
      await Promise.allSettled(running.values());
    },
  };
}
