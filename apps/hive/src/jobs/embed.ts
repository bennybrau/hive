import type pg from "pg";
import { toPgVector, type Embedder } from "../embed.js";
import { log as jsonLog } from "../log.js";

/** Tables with an `embedding` column, the text to embed, and the column to order the backlog by. */
const TARGETS = [
  { table: "facts", textCol: "text", orderCol: "recorded_at" },
  { table: "episodes", textCol: "content", orderCol: "created_at" },
  { table: "doc_chunks", textCol: "content", orderCol: "ingested_at" },
] as const;

/**
 * Embed up to `batch` un-embedded rows per table. Returns how many rows were embedded.
 * Every call to the model is written to llm_calls (cost 0 for local Ollama, tokens still counted).
 */
export async function runEmbedPass(pool: pg.Pool, embedder: Embedder, batch = 32): Promise<number> {
  let total = 0;
  for (const t of TARGETS) {
    const { rows } = await pool.query<{ id: string; body: string }>(
      `select id, ${t.textCol} as body from ${t.table} where embedding is null order by ${t.orderCol} limit $1`,
      [batch],
    );
    if (rows.length === 0) continue;
    const started = Date.now();
    const { vectors, tokens } = await embedder.embed(rows.map((r) => r.body), "document");
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (let i = 0; i < rows.length; i++) {
        await client.query(`update ${t.table} set embedding = $1::vector where id = $2`, [toPgVector(vectors[i]!), rows[i]!.id]);
      }
      await client.query(
        `insert into llm_calls (job, model, input_tokens, output_tokens, est_cost_usd, duration_ms)
         values ('embed', $1, $2, 0, 0, $3)`,
        [embedder.model, tokens, Date.now() - started],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    total += rows.length;
  }
  return total;
}

export interface EmbedWorker {
  /** Wake the worker now (called after writes) instead of waiting for the next tick. */
  kick(): void;
  stop(): Promise<void>;
  /** Last error message, or null when healthy. Surfaced on /v1/status. */
  lastError(): string | null;
}

/**
 * Background loop: drain the backlog, sleep, repeat. On failure (Ollama down) back off and keep
 * serving keyword-only; never crash the service.
 */
export function startEmbedWorker(
  pool: pg.Pool,
  embedder: Embedder,
  opts: { idleMs?: number; errorBackoffMs?: number; log?: (msg: string) => void } = {},
): EmbedWorker {
  const idleMs = opts.idleMs ?? 5_000;
  const backoffMs = opts.errorBackoffMs ?? 30_000;
  const log = opts.log ?? jsonLog.warn;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let error: string | null = null;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };

  async function tick(): Promise<void> {
    if (stopped || running) return;
    timer = null;
    running = (async () => {
      try {
        let n: number;
        do n = await runEmbedPass(pool, embedder); while (n > 0 && !stopped);
        if (error) log("embed worker: recovered");
        error = null;
        schedule(idleMs);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg !== error) log(`embed worker: ${msg} (keyword search still works; retrying in ${backoffMs / 1000}s)`);
        error = msg;
        schedule(backoffMs);
      }
    })();
    await running;
    running = null;
  }

  schedule(0);
  return {
    kick: () => {
      if (!running && !error) schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
    lastError: () => error,
  };
}
