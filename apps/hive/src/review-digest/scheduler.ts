/**
 * Sends the daily review digest. Each local date gets one `review_digests` row, claimed by the first tick at or after
 * the configured time; a channel that fails is retried a few times on later ticks. Missed days are not caught up.
 */
import type pg from "pg";
import { log as jsonLog } from "../log.js";
import { sendDigestChannels } from "./channels.js";
import { getReviewDigestConfig, type ReviewDigestConfig } from "./config.js";
import { buildDigest } from "./content.js";

/** Sends per date, counting the first. */
export const MAX_ATTEMPTS = 4;
/** Wait after the 1st, 2nd and 3rd send before retrying a failed channel. */
const RETRY_MINUTES = [1, 5, 15];

/** The local calendar date and wall-clock time of `now` in `timeZone`. */
export function localNow(now: Date, timeZone: string): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const OPEN = "in ('pending', 'failed')";

/** One scheduler pass: claims today's digest once it is due, then sends (or retries) whatever channels are still open. */
export async function digestTick(
  pool: pg.Pool,
  key: Buffer,
  opts: { now?: Date; telegramApiUrl?: string } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  let cfg: (ReviewDigestConfig & { user_id: string }) | null;
  try {
    cfg = await getReviewDigestConfig(pool, key);
  } catch {
    return; // stored under another key: as good as unset
  }
  if (!cfg?.enabled || (!cfg.email && !cfg.telegram)) return;
  const today = localNow(now, cfg.timezone);
  if (today.time < cfg.time) return;

  await pool.query(
    `insert into review_digests (local_date, claimed_at, next_attempt_at, email_status, telegram_status)
     values ($1, $2, $2, $3, $4) on conflict (local_date) do nothing`,
    [today.date, now, cfg.email ? "pending" : null, cfg.telegram ? "pending" : null],
  );

  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string; attempts: number; email_status: string | null; telegram_status: string | null }>(
      `select id, attempts, email_status, telegram_status from review_digests
       where local_date = $1 and attempts < $2 and next_attempt_at <= $3 and (email_status ${OPEN} or telegram_status ${OPEN})
       for update skip locked`,
      [today.date, MAX_ATTEMPTS, now],
    );
    const row = rows[0];
    if (!row) {
      await client.query("rollback");
      return;
    }

    const { rows: prev } = await client.query<{ since: Date | null }>(
      "select max(sent_at) as since from review_digests where local_date < $1",
      [today.date],
    );
    const digest = await buildDigest(pool, {
      user_id: cfg.user_id,
      timezone: cfg.timezone,
      dashboard_url: cfg.dashboard_url,
      since: prev[0]?.since ?? null,
      now,
    });

    if (digest.total === 0) {
      await client.query(
        "update review_digests set item_count = 0, email_status = null, telegram_status = null where id = $1",
        [row.id],
      );
    } else {
      const open = (s: string | null) => s === "pending" || s === "failed";
      const res = await sendDigestChannels(
        { email: open(row.email_status) ? cfg.email : null, telegram: open(row.telegram_status) ? cfg.telegram : null },
        digest,
        { attempts: 1, telegramApiUrl: opts.telegramApiUrl },
      );
      const sent = res.email?.status === "sent" || res.telegram?.status === "sent";
      const retryAt = new Date(now.getTime() + (RETRY_MINUTES[row.attempts] ?? RETRY_MINUTES.at(-1)!) * 60_000);
      await client.query(
        `update review_digests set
           item_count = $2,
           email_status = coalesce($3, email_status), email_error = case when $3::text is null then email_error else $4 end,
           telegram_status = coalesce($5, telegram_status), telegram_error = case when $5::text is null then telegram_error else $6 end,
           sent_at = case when $7 then coalesce(sent_at, $8) else sent_at end,
           attempts = attempts + 1,
           next_attempt_at = $9
         where id = $1`,
        [row.id, digest.total, res.email?.status ?? null, res.email?.error ?? null, res.telegram?.status ?? null, res.telegram?.error ?? null, sent, now, retryAt],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface ReviewDigestScheduler {
  stop(): Promise<void>;
}

/** Runs digestTick every minute. */
export function startReviewDigestScheduler(
  pool: pg.Pool,
  key: Buffer,
  opts: { intervalMs?: number; telegramApiUrl?: string; log?: (msg: string) => void } = {},
): ReviewDigestScheduler {
  const intervalMs = opts.intervalMs ?? 60_000;
  const log = opts.log ?? jsonLog.warn;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let error: string | null = null;

  const tick = () => {
    running = (async () => {
      try {
        await digestTick(pool, key, { telegramApiUrl: opts.telegramApiUrl });
        error = null;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg !== error) log(`review digest scheduler: ${msg}`);
        error = msg;
      }
    })().finally(() => {
      running = null;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
