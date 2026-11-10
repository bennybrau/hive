/**
 * Sends a review digest over its channels: Telegram (Bot API sendMessage) and email (SMTP). Errors never carry the
 * bot token or SMTP password.
 */
import nodemailer from "nodemailer";
import type { ReviewDigestConfig, ReviewDigestEmail, ReviewDigestTelegram } from "./config.js";
import { renderEmail, renderTelegram, type Digest } from "./content.js";

export const TELEGRAM_API_URL = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

/** `msg` with each secret, raw and URL-encoded, replaced by `***`. */
export function scrub(msg: string, secrets: (string | undefined)[]): string {
  let out = msg;
  for (const s of secrets) {
    if (!s) continue;
    for (const form of new Set([s, encodeURIComponent(s)])) out = out.split(form).join("***");
  }
  return out;
}

/** Posts `html` (Telegram HTML parse mode) to the chat. Throws on a non-2xx or `ok: false`, with Telegram's description. */
export async function sendTelegram(cfg: ReviewDigestTelegram, html: string, apiUrl = TELEGRAM_API_URL): Promise<void> {
  const res = await fetch(`${apiUrl}/bot${cfg.bot_token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: { ok?: boolean; description?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // not JSON: the status says enough
  }
  if (!res.ok || body.ok === false) throw new Error(body.description ?? `HTTP ${res.status}`);
}

export async function sendEmail(cfg: ReviewDigestEmail, msg: { subject: string; text: string; html: string }): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port,
    secure: cfg.smtp_secure,
    auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    logger: false,
  });
  try {
    await transport.sendMail({ from: cfg.from, to: cfg.to, subject: msg.subject, text: msg.text, html: msg.html });
  } finally {
    transport.close();
  }
}

/** How one channel went; `error` is scrubbed. */
export type ChannelResult = { status: "sent"; error: null } | { status: "failed"; error: string };

export interface SendOptions {
  /** Tries per channel (default 3). */
  attempts?: number;
  /** Wait before the first retry; each later one doubles (default 1 s). */
  backoffMs?: number;
  telegramApiUrl?: string;
}

async function withRetries(send: () => Promise<void>, secrets: (string | undefined)[], attempts: number, backoffMs: number): Promise<ChannelResult> {
  let error = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (i - 1)));
    try {
      await send();
      return { status: "sent", error: null };
    } catch (err) {
      error = scrub(err instanceof Error ? err.message : String(err), secrets);
    }
  }
  return { status: "failed", error };
}

/** Sends the digest on every configured channel at once, each retried on its own. Only configured channels have a key. */
export async function sendDigestChannels(
  cfg: Pick<ReviewDigestConfig, "email" | "telegram">,
  digest: Digest,
  opts: SendOptions = {},
): Promise<{ email?: ChannelResult; telegram?: ChannelResult }> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;
  const secrets = [cfg.telegram?.bot_token, cfg.email?.smtp_pass];
  const { email, telegram } = cfg;
  const [emailResult, telegramResult] = await Promise.all([
    email ? withRetries(() => sendEmail(email, renderEmail(digest)), secrets, attempts, backoffMs) : undefined,
    telegram ? withRetries(() => sendTelegram(telegram, renderTelegram(digest), opts.telegramApiUrl), secrets, attempts, backoffMs) : undefined,
  ]);
  return { ...(emailResult && { email: emailResult }), ...(telegramResult && { telegram: telegramResult }) };
}
