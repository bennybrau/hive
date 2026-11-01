import type pg from "pg";
import type { Instance } from "./auth.js";
import { toPgVector, type Embedder } from "./embed.js";
import { ConflictError, contentHash, normalizeText, type FactKind } from "./facts.js";

/** A job that has been claimed this many times and fails (or its lease expires) again is given up on. */
export const MAX_ATTEMPTS = 3;
/** Sent with every claim so the worker and the stored result agree on which prompt produced the facts. */
export const DISTILL_PROMPT_VERSION = "distill-v2";
/** Cosine above which a distilled fact is "the same" as an existing one in its scope (anchor, don't insert). */
const VECTOR_DUPE_MIN = 0.92;

export interface DistillJob {
  id: string;
  attempts: number;
  lease_until: string;
}

export interface DistillEpisode {
  id: string;
  kind: string;
  repo_key: string | null;
  content: string;
}

export interface DistilledFact {
  text: string;
  kind: FactKind;
  scope: string;
  quote: string;
  locus?: string[];
}

export interface DistillUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

export interface DistillResult {
  prompt_version: string;
  created: string[];
  anchored: string[];
  dropped: { text: string; reason: "quote_not_in_episode" | "scope_not_allowed" }[];
}

/**
 * In one transaction: claimed jobs whose lease ran out go back to `queued` (or `failed` after
 * MAX_ATTEMPTS), then the oldest queued job is leased to `workerId`. null = nothing to do.
 */
export async function claimJob(
  pool: pg.Pool,
  workerId: string,
  leaseSeconds: number,
): Promise<{ job: DistillJob; episode: DistillEpisode } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update distill_jobs
       set status = case when attempts >= $1 then 'failed' else 'queued' end,
           finished_at = case when attempts >= $1 then now() end,
           error = 'lease expired', claimed_by = null, lease_until = null
       where status = 'claimed' and lease_until < now()`,
      [MAX_ATTEMPTS],
    );
    const { rows } = await client.query<DistillJob & { episode_id: string }>(
      `update distill_jobs
       set status = 'claimed', attempts = attempts + 1, claimed_by = $1,
           lease_until = now() + make_interval(secs => $2)
       where id = (select id from distill_jobs where status = 'queued' order by created_at, id limit 1 for update skip locked)
       returning id, attempts, lease_until, episode_id`,
      [workerId, leaseSeconds],
    );
    const claimed = rows[0];
    let episode: DistillEpisode | undefined;
    if (claimed) {
      episode = (
        await client.query<DistillEpisode>("select id, kind, repo_key, content from episodes where id = $1", [claimed.episode_id])
      ).rows[0];
    }
    await client.query("commit");
    if (!claimed || !episode) return null;
    return {
      job: { id: claimed.id, attempts: claimed.attempts, lease_until: new Date(claimed.lease_until).toISOString() },
      episode,
    };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface OwnedJob {
  status: string;
  claimed_by: string | null;
  attempts: number;
}

function assertOwned(job: OwnedJob, worker: Instance): void {
  if (job.status !== "claimed" || job.claimed_by !== worker.id) {
    throw new ConflictError(job.status === "claimed" ? "job is claimed by another worker" : `job is ${job.status}, not claimed`);
  }
}

/**
 * Store a claimed job's distilled facts. A fact whose quote is not in the episode, or whose scope the
 * episode can't speak for, is dropped. A fact already known (same text, or cosine > 0.92 in its scope)
 * gains an anchor to this episode instead of a new row; the rest become `distilled` candidates.
 * null = no such job; ConflictError = the caller does not hold the claim.
 */
export async function completeJob(
  pool: pg.Pool,
  jobId: string,
  worker: Instance,
  input: { facts: DistilledFact[]; usage: DistillUsage },
  embedder: Embedder | null,
): Promise<DistillResult | null> {
  const pre = await pool.query<OwnedJob & { content: string; repo_key: string | null; user_id: string | null }>(
    `select j.status, j.claimed_by, j.attempts, e.content, e.repo_key, e.user_id
     from distill_jobs j join episodes e on e.id = j.episode_id where j.id = $1`,
    [jobId],
  );
  const ep = pre.rows[0];
  if (!ep) return null;
  assertOwned(ep, worker);

  const result: DistillResult = { prompt_version: DISTILL_PROMPT_VERSION, created: [], anchored: [], dropped: [] };
  const allowed = new Set(["global"]);
  if (ep.repo_key) allowed.add(`repo:${ep.repo_key}`);
  if (ep.user_id) allowed.add(`personal:${ep.user_id}`);
  const episodeText = normalizeText(ep.content);
  const kept: (DistilledFact & { text: string })[] = [];
  for (const f of input.facts) {
    const quote = normalizeText(f.quote);
    if (!quote || !episodeText.includes(quote)) result.dropped.push({ text: f.text, reason: "quote_not_in_episode" });
    else if (!allowed.has(f.scope)) result.dropped.push({ text: f.text, reason: "scope_not_allowed" });
    else kept.push({ ...f, text: normalizeText(f.text) });
  }

  // Embed outside the transaction; if the embedder is down, the vector dupe check is skipped and
  // the embed worker fills the embeddings in later.
  let vectors: (string | null)[] = kept.map(() => null);
  if (embedder && kept.length) {
    try {
      vectors = (await embedder.embed(kept.map((f) => f.text), "document")).vectors.map(toPgVector);
    } catch {
      // keyword-only: no vectors
    }
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query<OwnedJob & { episode_id: string; author_instance_id: string | null }>(
      `select j.status, j.claimed_by, j.attempts, j.episode_id, e.instance_id as author_instance_id
       from distill_jobs j join episodes e on e.id = j.episode_id where j.id = $1 for update of j`,
      [jobId],
    );
    const job = locked.rows[0]!;
    assertOwned(job, worker);

    for (let i = 0; i < kept.length; i++) {
      const f = kept[i]!;
      const vec = vectors[i]!;
      const hash = contentHash(f.text, f.scope);
      // Facts created earlier in this batch are visible here, so an in-batch dupe anchors to them.
      let factId = (await client.query<{ id: string }>("select id from facts where content_hash = $1", [hash])).rows[0]?.id;
      if (!factId && vec) {
        factId = (
          await client.query<{ id: string }>(
            `select id from facts
             where scope = $1 and status in ('candidate', 'active') and embedding is not null
               and 1 - (embedding <=> $2::vector) > $3
             order by embedding <=> $2::vector limit 1`,
            [f.scope, vec, VECTOR_DUPE_MIN],
          )
        ).rows[0]?.id;
      }
      if (factId) {
        result.anchored.push(factId);
      } else {
        const ins = await client.query<{ id: string }>(
          `insert into facts (text, kind, scope, locus, origin, status, author_user_id, author_instance_id, content_hash, embedding)
           values ($1, $2, $3, $4, 'distilled', 'candidate', $5, $6, $7, $8::vector)
           returning id`,
          [f.text, f.kind, f.scope, f.locus ?? [], ep.user_id, job.author_instance_id, hash, vec],
        );
        factId = ins.rows[0]!.id;
        result.created.push(factId);
      }
      await client.query(`insert into anchors (fact_id, episode_id, quote, repo_key) values ($1, $2, $3, $4)`, [
        factId,
        job.episode_id,
        f.quote,
        ep.repo_key,
      ]);
    }

    const u = input.usage;
    await client.query(
      `insert into llm_calls (job, model, input_tokens, output_tokens, cached_tokens, est_cost_usd, duration_ms, episode_id)
       values ('distill', $1, $2, $3, $4, $5, $6, $7)`,
      [u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cost_usd, u.duration_ms, job.episode_id],
    );
    await client.query(`update distill_jobs set status = 'done', finished_at = now(), lease_until = null, result = $2 where id = $1`, [
      jobId,
      result,
    ]);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The worker gave up on its claim: back to `queued` for another try, or `failed` after MAX_ATTEMPTS. */
export async function failJob(
  pool: pg.Pool,
  jobId: string,
  worker: Instance,
  error: string,
): Promise<{ id: string; status: string; attempts: number; error: string } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<OwnedJob>("select status, claimed_by, attempts from distill_jobs where id = $1 for update", [
      jobId,
    ]);
    if (!rows[0]) {
      await client.query("rollback");
      return null;
    }
    assertOwned(rows[0], worker);
    const upd = await client.query<{ id: string; status: string; attempts: number; error: string }>(
      `update distill_jobs
       set status = case when attempts >= $2 then 'failed' else 'queued' end,
           finished_at = case when attempts >= $2 then now() end,
           error = $3, claimed_by = null, lease_until = null
       where id = $1 returning id, status, attempts, error`,
      [jobId, MAX_ATTEMPTS, error],
    );
    await client.query("commit");
    return upd.rows[0]!;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Wakes long-polling claims when a new episode (maybe a job) arrives, instead of waiting for the next re-check. */
export class DistillNotifier {
  private waiters = new Set<() => void>();

  kick(): void {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  /** Resolves after `ms`, on the next kick(), or when `signal` aborts, whichever comes first. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done);
      this.waiters.add(done);
    });
  }
}
