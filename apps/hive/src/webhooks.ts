import { createHmac } from "node:crypto";
import type pg from "pg";
import { decryptSecret } from "./secrets.js";

export const WEBHOOK_EVENTS = ["fact.recorded", "fact.activated", "fact.retracted", "fact.superseded"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const BATCH = 10;
const TIMEOUT_MS = 10_000;
const MAX_BACKOFF_SECONDS = 3600;
/** A claimed row is invisible to other claims this long; covers a process that dies mid-POST. */
const CLAIM_LEASE_SECONDS = 300;

export interface DeliverOptions {
  /** Attempts before a delivery is `failed` (default 6). */
  maxAttempts?: number;
  /** Retry n waits base * 2^(n-1) seconds, capped at an hour (default 30). */
  backoffSeconds?: number;
  timeoutMs?: number;
}

/** `X-Hive-Signature`: HMAC-SHA256 of the exact request body under the webhook's secret. */
export function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function backoffSeconds(base: number, attempt: number): number {
  return Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_SECONDS);
}

interface Claimed {
  id: string;
  webhook_id: string;
  event: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
  url: string;
  secret_enc: Buffer;
}

async function post(row: Claimed, key: Buffer, timeoutMs: number): Promise<string | null> {
  try {
    const body = JSON.stringify({ id: row.id, event: row.event, occurred_at: row.created_at.toISOString(), fact: row.payload });
    const res = await fetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "hive-webhooks",
        "x-hive-signature": sign(decryptSecret(row.secret_enc, key), body),
        "x-hive-event": row.event,
        "x-hive-delivery": row.id,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    const e = err as Error & { cause?: { message?: string } };
    return e.cause?.message ? `${e.message}: ${e.cause.message}` : e.message;
  }
}

/** Claim up to 10 due deliveries and POST them. Returns how many were attempted. */
export async function deliverDue(pool: pg.Pool, key: Buffer, opts: DeliverOptions = {}): Promise<number> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const base = opts.backoffSeconds ?? 30;
  const { rows } = await pool.query<Claimed>(
    `with due as (
       select d.id from webhook_deliveries d join webhooks w on w.id = d.webhook_id
       where d.status = 'queued' and d.next_attempt_at <= now() and w.active -- an inactive hook's queue waits
       order by d.next_attempt_at, d.created_at
       limit ${BATCH}
       for update skip locked
     )
     update webhook_deliveries d
       set attempts = d.attempts + 1, next_attempt_at = now() + make_interval(secs => ${CLAIM_LEASE_SECONDS})
     from due, webhooks w
     where d.id = due.id and w.id = d.webhook_id
     returning d.id, d.webhook_id, d.event, d.payload, d.attempts, d.created_at, w.url, w.secret_enc`,
  );
  rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  await Promise.all(
    rows.map(async (row) => {
      const error = await post(row, key, opts.timeoutMs ?? TIMEOUT_MS);
      if (!error) {
        await pool.query(
          "update webhook_deliveries set status = 'delivered', delivered_at = now(), last_error = null where id = $1",
          [row.id],
        );
        await pool.query("update webhooks set failing_since = null, last_error = null where id = $1", [row.webhook_id]);
      } else if (row.attempts >= maxAttempts) {
        await pool.query("update webhook_deliveries set status = 'failed', last_error = $2 where id = $1", [row.id, error]);
        await pool.query(
          "update webhooks set failing_since = coalesce(failing_since, now()), last_error = $2 where id = $1",
          [row.webhook_id, error],
        );
      } else {
        await pool.query(
          "update webhook_deliveries set next_attempt_at = now() + make_interval(secs => $2), last_error = $3 where id = $1",
          [row.id, backoffSeconds(base, row.attempts), error],
        );
      }
    }),
  );
  return rows.length;
}

export interface WebhookDispatcher {
  stop(): Promise<void>;
}

/** Polls for due deliveries every 2 s (drains the backlog before sleeping). */
export function startWebhookDispatcher(
  pool: pg.Pool,
  key: Buffer,
  opts: DeliverOptions & { intervalMs?: number; log?: (msg: string) => void } = {},
): WebhookDispatcher {
  const intervalMs = opts.intervalMs ?? 2_000;
  const log = opts.log ?? ((m: string) => console.error(m));
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let error: string | null = null;

  const tick = () => {
    running = (async () => {
      try {
        while (!stopped && (await deliverDue(pool, key, opts)) > 0);
        error = null;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg !== error) log(`webhook dispatcher: ${msg}`);
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
