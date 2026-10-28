import { createHash } from "node:crypto";
import type pg from "pg";
import type { Instance } from "./auth.js";

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
}

export const FACT_COLUMNS = "id, text, kind, scope, locus, origin, status, status_note, author_user_id, recorded_at";

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
      await client.query("rollback");
      const existing = await pool.query<Fact>(`select ${FACT_COLUMNS} from facts where content_hash = $1`, [hash]);
      return { fact: existing.rows[0]!, deduped: true };
    }
    const fact = ins.rows[0]!;
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
