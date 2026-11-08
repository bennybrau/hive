import { createHash } from "node:crypto";
import type pg from "pg";
import type { Instance } from "./auth.js";
import { readableScopes } from "./scope.js";

export const FACT_KINDS = ["decision", "invariant", "gotcha", "preference", "convention", "system"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export type Origin = "authored" | "distilled" | "ingested";
export type Status = "candidate" | "active" | "superseded" | "retracted";

export interface AnchorInput {
  episode_id?: string;
  repo_key?: string;
  commit_sha?: string;
  path?: string;
  line_start?: number;
  line_end?: number;
  quote?: string;
}

export interface FactInput {
  text: string;
  kind: FactKind;
  scope: string; // already resolved (global | repo:<key> | personal:<user>)
  origin: Origin;
  locus?: string[];
  anchors?: AnchorInput[];
  confidence?: number;
  /** An active fact in the same scope that this one replaces (once it is active). */
  supersedes?: string;
}

export interface Fact {
  id: string;
  text: string;
  kind: FactKind;
  scope: string;
  locus: string[];
  origin: Origin;
  status: Status;
  status_note: string | null;
  author_user_id: string | null;
  recorded_at: string;
  /**
   * Per-fact flags; `asked: true` = a person asked for this fact to be remembered. `replaces` = the active fact a
   * distilled candidate corrects; approving it supersedes that fact. `correction` = a person corrected an answer that
   * cited this fact (see flagCorrection); it is back in the review queue until curated.
   */
  metadata: { asked?: boolean; replaces?: string; correction?: Correction };
}

export interface Correction {
  text: string;
  episode_id: string;
  /** The distilled candidate that replaces this fact, or null (a turn the plugin marked as a correction). */
  candidate_id: string | null;
  at: string;
}

/** Correction text kept on a flagged fact. */
const CORRECTION_TEXT_MAX = 500;

/**
 * A person corrected an answer that cited this fact: set `metadata.correction` (the latest flag wins). Only an active
 * fact is flagged; true when it was.
 */
export async function flagCorrection(
  db: pg.Pool | pg.PoolClient,
  factId: string,
  c: { text: string; episode_id: string; candidate_id: string | null },
): Promise<boolean> {
  const res = await db.query(
    `update facts set metadata = metadata || jsonb_build_object('correction',
       jsonb_build_object('text', $2::text, 'episode_id', $3::uuid, 'candidate_id', $4::uuid, 'at', now()))
     where id = $1 and status = 'active'`,
    [factId, c.text.slice(0, CORRECTION_TEXT_MAX), c.episode_id, c.candidate_id],
  );
  return (res.rowCount ?? 0) > 0;
}

export const FACT_COLUMNS = "id, text, kind, scope, locus, origin, status, status_note, author_user_id, recorded_at, metadata";

/**
 * A brief or recall returned these facts: count it. Best effort: a failure is logged, never fails the request.
 */
export async function recordUse(pool: pg.Pool, ids: string[], log: { warn: (obj: unknown, msg?: string) => void }): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  try {
    await pool.query(
      `update facts set use_count = use_count + 1, last_used_at = now() where id = any($1::uuid[]) and status = 'active'`,
      [unique],
    );
  } catch (err) {
    log.warn({ err }, "fact use not recorded");
  }
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Content-derived identity: the same statement in the same scope is the same fact, regardless of
 * who said it or how it was spaced/cased. A second remember adds nothing (dedupe, not a new row).
 */
export function contentHash(text: string, scope: string): string {
  return createHash("sha256").update(`${normalizeText(text).toLowerCase()}\u0000${scope}`).digest("hex");
}

/**
 * Status rules (docs/MVP-PLAN.md section 2):
 *  - ingested (ground truth)            -> active
 *  - personal scope                     -> active (your notes are yours)
 *  - shared scope, written by a curator -> active (the curator IS the review gate; logged as a self-approve)
 *  - shared scope, anyone else          -> candidate until reviewed
 */
export function initialStatus(origin: Origin, scope: string, role: Instance["role"]): Status {
  if (origin === "ingested") return "active";
  if (scope.startsWith("personal:")) return "active";
  if (role === "curator") return "active";
  return "candidate";
}

export async function createFact(
  pool: pg.Pool,
  input: FactInput,
  author: Instance,
): Promise<{ fact: Fact; deduped: boolean }> {
  const text = normalizeText(input.text);
  const status = initialStatus(input.origin, input.scope, author.role);
  const hash = contentHash(text, input.scope);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<Fact>(
      `insert into facts (text, kind, scope, locus, origin, status, confidence, author_user_id, author_instance_id, content_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (content_hash) do nothing
       returning ${FACT_COLUMNS}`,
      [text, input.kind, input.scope, input.locus ?? [], input.origin, status, input.confidence ?? null,
       author.user_id, author.id, hash],
    );
    if (ins.rowCount === 0) {
      // A dedupe changes nothing, so a supersedes on it is ignored.
      await client.query("rollback");
      const existing = await pool.query<Fact>(`select ${FACT_COLUMNS} from facts where content_hash = $1`, [hash]);
      return { fact: existing.rows[0]!, deduped: true };
    }
    const fact = ins.rows[0]!;
    if (input.supersedes) {
      const [scopeSql, scopeParams] = readableScopes(author, undefined, 2);
      const old = await client.query<{ scope: string; status: Status }>(
        `select scope, status from facts where id = $1 and ${scopeSql} for update`,
        [input.supersedes, ...scopeParams],
      );
      const target = old.rows[0];
      if (!target) throw new SupersedeError("supersedes: no such fact");
      if (target.status !== "active") throw new SupersedeError(`supersedes: that fact is ${target.status}, not active`);
      if (target.scope !== input.scope) throw new SupersedeError(`supersedes: that fact is in ${target.scope}, not ${input.scope}`);
      await client.query("update facts set supersedes = $2 where id = $1", [fact.id, input.supersedes]);
      if (status === "active") await activateSupersede(client, { supersedes: input.supersedes });
    }
    for (const a of input.anchors ?? []) {
      await client.query(
        `insert into anchors (fact_id, episode_id, repo_key, commit_sha, path, line_start, line_end, quote)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fact.id, a.episode_id ?? null, a.repo_key ?? null, a.commit_sha ?? null, a.path ?? null,
         a.line_start ?? null, a.line_end ?? null, a.quote ?? null],
      );
    }
    if (status === "active" && author.role === "curator" && !input.scope.startsWith("personal:") && input.origin !== "ingested") {
      await client.query(
        `insert into reviews (fact_id, reviewer_user_id, action, note) values ($1, $2, 'approve', 'authored by curator')`,
        [fact.id, author.user_id],
      );
    }
    await client.query("commit");
    return { fact, deduped: false };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export class NotAllowedError extends Error {}
export class SupersedeError extends Error {}
export class ConflictError extends Error {}

/** The fact just became active: the fact it supersedes, if still active, stops being current. */
export async function activateSupersede(client: pg.PoolClient, fact: { supersedes: string | null }): Promise<void> {
  if (!fact.supersedes) return;
  await client.query(`update facts set status = 'superseded', valid_to = now() where id = $1 and status = 'active'`, [
    fact.supersedes,
  ]);
}

/**
 * A candidate's `metadata.replaces` becomes its `supersedes` when it has none yet and that fact is still active in its
 * scope; that fact then stops being current. The candidate must be active by now.
 */
async function adoptReplaces(client: pg.PoolClient, cand: Locked): Promise<void> {
  const target = cand.metadata.replaces;
  if (cand.supersedes || !target) return;
  const old = await client.query("select 1 from facts where id = $1 and status = 'active' and scope = $2 for update", [target, cand.scope]);
  if (!old.rowCount) return;
  await client.query("update facts set supersedes = $2 where id = $1", [cand.id, target]);
  await activateSupersede(client, { supersedes: target });
}

/** Retract = mark false, keep as history. Author or curator only. */
export async function retractFact(pool: pg.Pool, id: string, by: Instance, reason: string): Promise<Fact | null> {
  const { rows } = await pool.query<Fact & { author_user_id: string | null }>(
    `select ${FACT_COLUMNS} from facts where id = $1`,
    [id],
  );
  const fact = rows[0];
  if (!fact) return null;
  if (by.role !== "curator" && fact.author_user_id !== by.user_id) {
    throw new NotAllowedError("only the author or a curator can retract a fact");
  }
  const upd = await pool.query<Fact>(
    `update facts set status = 'retracted', status_note = $2, valid_to = now(), expired_at = now()
     where id = $1 returning ${FACT_COLUMNS}`,
    [id, reason],
  );
  return upd.rows[0]!;
}

export type ReviewAction = "approve" | "fix" | "reject";

export interface ReviewInput {
  action: ReviewAction;
  note?: string;
  new_text?: string;
}

type Locked = Fact & { supersedes: string | null; content_hash: string };
const LOCKED_COLUMNS = `${FACT_COLUMNS}, supersedes, content_hash`;

/**
 * A curator decides on a candidate. approve -> active; fix -> new text (re-embedded by the worker) and
 * active, or merged into the fact that already has that text; reject -> retracted. An approve or a fix that isn't
 * a merge also supersedes the fact in `metadata.replaces` (see adoptReplaces). Every decision is a reviews row. null = no such fact; ConflictError = not a candidate, or a fix whose text is a dead fact.
 */
export async function reviewFact(
  pool: pg.Pool,
  id: string,
  curator: Instance,
  input: ReviewInput,
): Promise<{ fact: Fact; merged_into: Fact | null } | null> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const [scopeSql, scopeParams] = readableScopes(curator, undefined, 2);
    const sel = await client.query<Locked>(`select ${LOCKED_COLUMNS} from facts where id = $1 and ${scopeSql} for update`, [
      id,
      ...scopeParams,
    ]);
    const cand = sel.rows[0];
    if (!cand) {
      await client.query("rollback");
      return null;
    }
    if (cand.status !== "candidate") throw new ConflictError(`fact is ${cand.status}, not a candidate`);

    const updateFact = (factId: string, sql: string, params: unknown[] = []) =>
      client.query<Fact>(`update facts set ${sql} where id = $1 returning ${FACT_COLUMNS}`, [factId, ...params]).then((r) => r.rows[0]!);
    let fact: Fact;
    let mergedInto: Fact | null = null;
    let newText: string | null = null;
    if (input.action === "approve") {
      fact = await updateFact(id, "status = 'active'");
      await activateSupersede(client, cand);
      await adoptReplaces(client, cand);
    } else if (input.action === "reject") {
      fact = await updateFact(id, "status = 'retracted', status_note = $2, valid_to = now()", [
        input.note ? `rejected: ${input.note}` : "rejected",
      ]);
    } else {
      newText = normalizeText(input.new_text ?? "");
      const hash = contentHash(newText, cand.scope);
      const hit =
        hash === cand.content_hash
          ? undefined
          : (await client.query<Locked>(`select ${LOCKED_COLUMNS} from facts where content_hash = $1 for update`, [hash])).rows[0];
      if (!hit) {
        fact = await updateFact(id, "text = $2, content_hash = $3, embedding = null, status = 'active'", [newText, hash]);
        await activateSupersede(client, cand);
        await adoptReplaces(client, cand);
      } else {
        if (hit.status !== "active" && hit.status !== "candidate") {
          throw new ConflictError(`that text is already fact ${hit.id}, which is ${hit.status}`);
        }
        await client.query("update anchors set fact_id = $2 where fact_id = $1", [id, hit.id]);
        fact = await updateFact(id, "status = 'retracted', status_note = $2, valid_to = now()", [`merged into ${hit.id}`]);
        if (hit.status === "candidate") {
          mergedInto = await updateFact(hit.id, "status = 'active'");
          await activateSupersede(client, hit);
          await client.query(`insert into reviews (fact_id, reviewer_user_id, action, note) values ($1, $2, 'approve', $3)`, [
            hit.id,
            curator.user_id,
            `merged from ${id}`,
          ]);
        } else {
          const { supersedes: _s, content_hash: _h, ...rest } = hit;
          mergedInto = rest;
        }
      }
    }
    await client.query(`insert into reviews (fact_id, reviewer_user_id, action, note, new_text) values ($1, $2, $3, $4, $5)`, [
      id,
      curator.user_id,
      input.action,
      input.note ?? null,
      newText,
    ]);
    await client.query("commit");
    return { fact, merged_into: mergedInto };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** When a fact was last used or kept, whichever is later; recorded_at stands in for either that never happened. */
export const IDLE_SQL = "greatest(coalesce(last_used_at, recorded_at), coalesce(kept_at, recorded_at))";

/** Stale = active, not pinned, and idle for more than `days` (a positive integer, validated by config; inlined). */
export function staleSql(days: number): string {
  if (!Number.isInteger(days) || days <= 0) throw new Error(`stale days must be a positive integer: ${days}`);
  return `(status = 'active' and not pinned and ${IDLE_SQL} < now() - interval '${days} days')`;
}

/** A curate answer also shows the curation state. */
const CURATED_COLUMNS = `${FACT_COLUMNS}, pinned, kept_at`;

export type CurateAction = "keep" | "fix" | "retire" | "pin" | "unpin";

export interface CurateInput {
  action: CurateAction;
  note?: string;
  new_text?: string;
}

/**
 * A curator decides on an active fact. keep -> still true: kept_at = now() (its idle time restarts) and
 * metadata.correction cleared; pin/unpin -> pinned facts are never stale; fix -> a new active fact with the new text
 * (same kind, scope and locus; no anchors) supersedes it; retire -> retracted with `retired: <note>` (or `retired: stale`).
 * fix and retire clear metadata.correction too.
 * Every decision is a reviews row on this fact. null = no such fact; ConflictError = not active, or a fix whose text
 * is already a fact (this one is left alone).
 */
export async function curateFact(
  pool: pg.Pool,
  id: string,
  curator: Instance,
  input: CurateInput,
): Promise<{ fact: Fact & { pinned: boolean; kept_at: string | null }; new_fact: Fact | null } | null> {
  const [scopeSql, scopeParams] = readableScopes(curator, undefined, 2);
  const review = (db: pg.Pool | pg.PoolClient, newText: string | null = null) =>
    db.query(`insert into reviews (fact_id, reviewer_user_id, action, note, new_text) values ($1, $2, $3, $4, $5)`, [
      id,
      curator.user_id,
      input.action,
      input.note ?? null,
      newText,
    ]);

  if (input.action === "fix" || input.action === "retire") {
    const reread = async () => {
      await pool.query("update facts set metadata = metadata - 'correction' where id = $1", [id]);
      return (await pool.query(`select ${CURATED_COLUMNS} from facts where id = $1`, [id])).rows[0]!;
    };
    const sel = await pool.query<Fact>(
      `select ${FACT_COLUMNS} from facts where id = $1 and ${scopeSql}`,
      [id, ...scopeParams],
    );
    const old = sel.rows[0];
    if (!old) return null;
    if (old.status !== "active") throw new ConflictError(`fact is ${old.status}, not active`);
    if (input.action === "retire") {
      await retractFact(pool, id, curator, `retired: ${input.note || "stale"}`);
      await review(pool);
      return { fact: await reread(), new_fact: null };
    }
    let created: { fact: Fact; deduped: boolean };
    try {
      created = await createFact(
        pool,
        { text: input.new_text ?? "", kind: old.kind, scope: old.scope, origin: "authored", locus: old.locus, supersedes: id },
        curator,
      );
    } catch (err) {
      if (err instanceof SupersedeError) throw new ConflictError(err.message);
      throw err;
    }
    if (created.deduped) throw new ConflictError(`that text is already fact ${created.fact.id}, which is ${created.fact.status}`);
    await review(pool, created.fact.text);
    return { fact: await reread(), new_fact: created.fact };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const sel = await client.query<{ status: Status }>(`select status from facts where id = $1 and ${scopeSql} for update`, [
      id,
      ...scopeParams,
    ]);
    if (!sel.rows[0]) {
      await client.query("rollback");
      return null;
    }
    if (sel.rows[0].status !== "active") throw new ConflictError(`fact is ${sel.rows[0].status}, not active`);
    const set =
      input.action === "keep"
        ? "kept_at = now(), metadata = metadata - 'correction'"
        : `pinned = ${input.action === "pin" ? "true" : "false"}`;
    const upd = await client.query(`update facts set ${set} where id = $1 returning ${CURATED_COLUMNS}`, [id]);
    await review(client);
    await client.query("commit");
    return { fact: upd.rows[0]!, new_fact: null };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface ChainLink {
  id: string;
  text: string;
  status: Status;
  recorded_at: string;
}

/** The supersede chain around a fact: what it replaced (older, nearest first) and what replaced it (newer, nearest first). */
export async function factChain(pool: pg.Pool, id: string): Promise<{ supersedes: ChainLink[]; superseded_by: ChainLink[] }> {
  const { rows } = await pool.query<ChainLink & { dir: "older" | "newer" }>(
    `with recursive
       older as (
         select f.id, f.supersedes, 1 as depth from facts f where f.id = (select supersedes from facts where id = $1)
         union all
         select f.id, f.supersedes, o.depth + 1 from facts f join older o on f.id = o.supersedes where o.depth < 100
       ),
       newer as (
         select f.id, 1 as depth from facts f where f.supersedes = $1
         union all
         select f.id, n.depth + 1 from facts f join newer n on f.supersedes = n.id where n.depth < 100
       ),
       chain as (
         select id, depth, 'older' as dir from older
         union all
         select id, depth, 'newer' as dir from newer
       )
     select c.dir, f.id, f.text, f.status, f.recorded_at
     from chain c join facts f on f.id = c.id
     order by c.depth, f.recorded_at`,
    [id],
  );
  const link = ({ id, text, status, recorded_at }: ChainLink): ChainLink => ({ id, text, status, recorded_at });
  return {
    supersedes: rows.filter((r) => r.dir === "older").map(link),
    superseded_by: rows.filter((r) => r.dir === "newer").map(link),
  };
}
