/**
 * The daily review digest's settings: when to send, where to link, and the email / Telegram channels. Stored as one
 * encrypted JSON blob in `settings` (key `review_digest`); `set_by_user_id` is the curator the digest is built for.
 */
import type pg from "pg";
import { decryptSecret, encryptSecret } from "../secrets.js";

export const REVIEW_DIGEST = "review_digest";
export const DEFAULT_TIME = "18:00";
export const DEFAULT_TIMEZONE = "America/Chicago";

export interface ReviewDigestEmail {
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string;
  smtp_pass: string;
  from: string;
  to: string[];
}
export interface ReviewDigestTelegram {
  bot_token: string;
  chat_id: string;
}
export interface ReviewDigestConfig {
  enabled: boolean;
  time: string;
  timezone: string;
  dashboard_url: string;
  /** null = channel off */
  email: ReviewDigestEmail | null;
  telegram: ReviewDigestTelegram | null;
}

/** The PUT body: like the config, but time/timezone may be omitted and the secrets may be left out to keep them. */
export interface ReviewDigestInput {
  enabled: boolean;
  time?: string;
  timezone?: string;
  dashboard_url: string;
  email?: Omit<ReviewDigestEmail, "smtp_pass"> & { smtp_pass?: string };
  telegram?: Omit<ReviewDigestTelegram, "bot_token"> & { bot_token?: string };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Checks a PUT body (already shape-checked) and fills defaults. An omitted smtp_pass / bot_token keeps the stored one.
 * Returns the config to save, or a plain error message.
 */
export function validateReviewDigest(body: ReviewDigestInput, stored: ReviewDigestConfig | null): ReviewDigestConfig | string {
  const time = body.time ?? DEFAULT_TIME;
  if (!TIME_RE.test(time)) return "time must be HH:MM between 00:00 and 23:59";
  const timezone = body.timezone ?? DEFAULT_TIMEZONE;
  if (!isTimeZone(timezone)) return `unknown timezone: ${timezone}`;
  if (!isHttpUrl(body.dashboard_url)) return "dashboard_url must be an http(s) URL";

  let email: ReviewDigestEmail | null = null;
  if (body.email) {
    const e = body.email;
    if (!EMAIL_RE.test(e.from)) return "email.from must be an email address";
    const bad = e.to.find((t) => !EMAIL_RE.test(t));
    if (bad !== undefined) return "email.to must be email addresses";
    const smtp_pass = e.smtp_pass ?? stored?.email?.smtp_pass;
    if (!smtp_pass) return "email.smtp_pass is required (none is stored)";
    email = { smtp_host: e.smtp_host, smtp_port: e.smtp_port, smtp_secure: e.smtp_secure, smtp_user: e.smtp_user, smtp_pass, from: e.from, to: e.to };
  }

  let telegram: ReviewDigestTelegram | null = null;
  if (body.telegram) {
    const bot_token = body.telegram.bot_token ?? stored?.telegram?.bot_token;
    if (!bot_token) return "telegram.bot_token is required (none is stored)";
    telegram = { bot_token, chat_id: body.telegram.chat_id };
  }

  return { enabled: body.enabled, time, timezone, dashboard_url: body.dashboard_url, email, telegram };
}

/** The stored config (decrypted) and the curator who saved it; null when not set. Throws if it can't be decrypted. */
export async function getReviewDigestConfig(
  pool: pg.Pool,
  key: Buffer,
): Promise<(ReviewDigestConfig & { user_id: string }) | null> {
  const { rows } = await pool.query<{ value_enc: Buffer; set_by_user_id: string }>(
    "select value_enc, set_by_user_id from settings where key = $1",
    [REVIEW_DIGEST],
  );
  if (!rows[0]) return null;
  const cfg = JSON.parse(decryptSecret(rows[0].value_enc, key)) as ReviewDigestConfig;
  return { ...cfg, user_id: rows[0].set_by_user_id };
}

export async function saveReviewDigestConfig(pool: pg.Pool, key: Buffer, cfg: ReviewDigestConfig, userId: string): Promise<void> {
  await pool.query(
    `insert into settings (key, value_enc, set_by_user_id) values ($1, $2, $3)
     on conflict (key) do update set value_enc = excluded.value_enc, set_at = now(), set_by_user_id = excluded.set_by_user_id`,
    [REVIEW_DIGEST, encryptSecret(JSON.stringify(cfg), key), userId],
  );
}
