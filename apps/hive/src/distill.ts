import type pg from "pg";
import type { Instance } from "./auth.js";
import { toPgVector, type Embedder } from "./embed.js";
import { ConflictError, contentHash, flagCorrection, initialStatus, normalizeText, type FactKind } from "./facts.js";

/** A job that has been claimed this many times and fails (or its lease expires) again is given up on. */
export const MAX_ATTEMPTS = 3;
/** Sent with every claim so the worker and the stored result agree on which prompt produced the facts. */
export const DISTILL_PROMPT_VERSION = "distill-v7";
/** Cosine above which a distilled fact is "the same" as an existing one in its scope (anchor, don't insert). */
const VECTOR_DUPE_MIN = 0.92;
/** Cosine from which a fact anchored on the same quote in its scope is "the same" (a paraphrase of one decision). */
const QUOTE_DUPE_MIN = 0.8;
/** A claim sends the distiller up to this many active facts close to the episode, any of which a fact may replace. */
export const RELATED_MAX = 8;

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
  /** A turn the user flagged: distill what they asked to remember. */
  remember_request: boolean;
  /** `personal:<user>` on a remember job (a scope its facts may also take), else null. */
  personal_scope: string | null;
}

export interface DistilledFact {
  text: string;
  kind: FactKind;
  scope: string;
  quote: string;
  locus?: string[];
  /** The id of a `related` fact this one corrects or updates (kept on a new distilled candidate only). */
  replaces?: string;
}

/** An active fact sent with a claim: the distiller may say a new fact `replaces` it. */
export interface RelatedFact {
  id: string;
  text: string;
  kind: FactKind;
  scope: string;
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
  dropped: { text: string; reason: "quote_not_in_episode" | "non_user_quote" | "scope_not_allowed" }[];
  /** Facts dropped because their quote is in the episode but not in a `user:` turn (session jobs only). */
  dropped_non_user_quote: number;
}

/** A `tool(clarify)` line holds the user's answers to the agent's questions. */
const CLARIFY_PREFIX = "tool(clarify): ";
/** One answer in a clarify result, still JSON-escaped (so it stays a substring of the episode). Works on a clipped line. */
const USER_RESPONSE = /"user_response":\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * The user turns of a rendered transcript: each starts at a line beginning `user: ` and runs up to the next line
 * starting with `user: `, `assistant` (`assistant:` or `assistant -> tool call`) or `tool(`. Each `user_response`
 * value on a `tool(clarify): ` line is a turn of its own: the user answering the agent's question.
 */
export function userTurns(content: string): string[] {
  const turns: string[] = [];
  let turn: string[] | null = null;
  for (const line of content.split("\n")) {
    if (line.startsWith("user: ")) {
      if (turn) turns.push(turn.join("\n"));
      turn = [line];
    } else if (line.startsWith("assistant") || line.startsWith("tool(")) {
      if (turn) turns.push(turn.join("\n"));
      turn = null;
      if (line.startsWith(CLARIFY_PREFIX)) for (const m of line.matchAll(USER_RESPONSE)) turns.push(m[1]!);
    } else turn?.push(line);
  }
  if (turn) turns.push(turn.join("\n"));
  return turns;
}

/**
 * The first user turn (as in userTurns) containing the quote, whitespace collapsed: where it starts in the content and
 * its text (`user: ` removed; a clarify answer unescaped). null when no user turn has it.
 */
export function quotedUserTurn(content: string, quote: string): { start: number; text: string } | null {
  const q = normalizeText(quote);
  if (!q) return null;
  let turn: { start: number; lines: string[] } | null = null;
  const close = () => {
    const text = turn?.lines.join("\n");
    return turn && text !== undefined && normalizeText(text).includes(q) ? { start: turn.start, text: text.slice("user: ".length) } : null;
  };
  let at = 0;
  for (const line of [...content.split("\n"), "user: "]) {
    const start = at;
    at += line.length + 1;
    if (line.startsWith("user: ") || line.startsWith("assistant") || line.startsWith("tool(")) {
      const hit = close();
      if (hit) return hit;
      turn = line.startsWith("user: ") ? { start, lines: [line] } : null;
      if (line.startsWith(CLARIFY_PREFIX)) {
        const m = [...line.matchAll(USER_RESPONSE)].find((r) => normalizeText(r[1]!).includes(q));
        if (m) return { start, text: unescapeJson(m[1]!) };
      }
    } else turn?.lines.push(line);
  }
  return null;
}

/** Words that make a question a redirect or a decision ("Can we use Postgres instead?"), matched lower-case anywhere. */
const NOT_PLAIN_MARKERS = [
  "instead", "actually", "rather", "don't", "do not", "never", "always", "from now on", "let's", "should be", "must",
  "i want", "i'd like", "please", "remember", "no,", "not ",
];

/**
 * A `user: ` turn that only asks: it ends in `?` and has none of the markers. When unsure it says no (so the session
 * is distilled): a clarify answer (no `user: ` prefix) is never a plain question.
 */
export function isPlainQuestion(turn: string): boolean {
  if (!turn.startsWith("user: ")) return false;
  const text = turn.slice("user: ".length).trim().toLowerCase().replaceAll("’", "'");
  return text.endsWith("?") && !NOT_PLAIN_MARKERS.some((m) => text.includes(m));
}

/** Every user turn is a plain question (or there are none): no fact could quote the person, so nothing to distill. */
export function questionsOnly(content: string): boolean {
  return userTurns(content).every(isPlainQuestion);
}

/** The assistant text kept before a user turn in the distill view: its last this-many chars. */
export const VIEW_ASSISTANT_CHARS = 2000;

/**
 * What the distiller reads: every `user:` turn and `tool(clarify)` line in full, each after the last `assistant:` text
 * since the previous kept piece (clipped to its last VIEW_ASSISTANT_CHARS, marked `[…]`). Tool calls, other tool
 * output and other assistant text are dropped; a `…` line stands wherever something was. The quote checks still use
 * the full content.
 */
export function distillView(content: string): string {
  const blocks: { kind: "user" | "assistant" | "other"; lines: string[] }[] = [];
  for (const line of content.split("\n")) {
    const kind =
      line.startsWith("user: ") || line.startsWith(CLARIFY_PREFIX)
        ? "user"
        : line.startsWith("assistant: ")
          ? "assistant"
          : line.startsWith("assistant") || line.startsWith("tool(")
            ? "other"
            : null;
    if (kind) blocks.push({ kind, lines: [line] });
    else if (blocks.length) blocks.at(-1)!.lines.push(line);
    else blocks.push({ kind: "other", lines: [line] }); // text before the first turn
  }
  const keep = blocks.map(() => false);
  let lastKept = -1;
  blocks.forEach((b, i) => {
    if (b.kind !== "user") return;
    for (let j = i - 1; j > lastKept; j--) {
      if (blocks[j]!.kind === "assistant") {
        keep[j] = true;
        break;
      }
    }
    keep[i] = true;
    lastKept = i;
  });
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (!keep[i]) {
      if (i === 0 || keep[i - 1]) out.push("…");
      return;
    }
    const text = b.lines.join("\n");
    if (b.kind !== "assistant") return out.push(text);
    const body = text.slice("assistant: ".length);
    out.push(body.length > VIEW_ASSISTANT_CHARS ? `assistant: […]${body.slice(-VIEW_ASSISTANT_CHARS)}` : text);
  });
  return out.join("\n");
}

/** The answers on a `tool(clarify): ` line with the question each answers (null when the line doesn't parse). */
function clarifyAnswers(line: string): { question: string | null; raw: string }[] {
  let responses: unknown[] = [];
  try {
    const parsed = JSON.parse(line.slice(CLARIFY_PREFIX.length)) as { responses?: unknown };
    responses = Array.isArray(parsed?.responses) ? parsed.responses : [parsed];
  } catch {
    // clipped: answers only
  }
  // a skipped question (`user_response: null`) has no match, so pair matches with answered responses only
  responses = responses.filter((r) => typeof (r as { user_response?: unknown } | null)?.user_response === "string");
  return [...line.matchAll(USER_RESPONSE)].map((m, i) => {
    const q = (responses[i] as { question?: unknown } | undefined)?.question;
    return { question: typeof q === "string" ? q : null, raw: m[1]! };
  });
}

/** A JSON string body (no quotes) as text; as is when it doesn't parse. */
function unescapeJson(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** The bot's reply before a quoted user turn keeps only its last this-many chars. */
export const EXCHANGE_ASSISTANT_CHARS = 600;

/**
 * The exchange a quote came from: the first user turn containing it (same check as distill) and the `assistant:` text
 * turns since the previous user turn (tool calls and output skipped), prefixes removed. A clarify answer's exchange is
 * the question it answers (null if the line is clipped) and the answer. null when no user turn has it.
 */
export function exchangeFor(content: string, quote: string): { assistant: string | null; user: string } | null {
  const q = normalizeText(quote);
  if (!q) return null;
  let said: string[] = [];
  let turn: { role: "user" | "assistant" | "other"; lines: string[] } | null = null;
  const close = (): string | null => {
    if (turn?.role === "assistant") said.push(turn.lines.join("\n"));
    else if (turn?.role === "user") {
      const text = turn.lines.join("\n");
      if (normalizeText(text).includes(q)) return text;
      said = [];
    }
    return null;
  };
  for (const line of [...content.split("\n"), "user: "]) {
    const role = line.startsWith("user: ")
      ? "user"
      : line.startsWith("assistant: ")
        ? "assistant"
        : line.startsWith("assistant") || line.startsWith("tool(")
          ? "other"
          : null;
    if (!role) {
      turn?.lines.push(line);
      continue;
    }
    const user = close();
    if (user !== null) {
      return { assistant: said.length ? said.join("\n").slice(-EXCHANGE_ASSISTANT_CHARS) : null, user: user.slice("user: ".length) };
    }
    if (line.startsWith(CLARIFY_PREFIX)) {
      const hit = clarifyAnswers(line).find((a) => normalizeText(a.raw).includes(q));
      if (hit) return { assistant: hit.question, user: unescapeJson(hit.raw) };
    }
    turn = { role, lines: [role === "assistant" ? line.slice("assistant: ".length) : line] };
  }
  return null;
}

/** The scopes an episode's facts may take: `global`, `repo:<key>` with a repo, `personal:<user>` with a user. */
export function episodeScopes(repoKey: string | null, userId: string | null): string[] {
  const scopes = ["global"];
  if (repoKey) scopes.push(`repo:${repoKey}`);
  if (userId) scopes.push(`personal:${userId}`);
  return scopes;
}

/** The OR-ed keyword query of a fact's text (same shape as search.ts TSQUERY), on facts `f`. */
const FACT_TSQUERY = "replace(plainto_tsquery('english', f.text)::text, '&', '|')::tsquery";

/** SQL (on episodes `e`): this is a remember job, a turn the user flagged. */
const REMEMBER_SQL = `(e.kind = 'turn' and coalesce(e.metadata->>'remember_request' = 'true', false))`;

/**
 * In one transaction: claimed jobs whose lease ran out go back to `queued` (or `failed` after
 * MAX_ATTEMPTS), then the queued job with the highest priority (oldest first) is leased to `workerId`.
 * Except on a remember or asf_run job, the claim also sends up to RELATED_MAX active facts in the episode's scopes,
 * closest first (by cosine when the episode is embedded, else facts sharing a word with it, by keyword rank), and
 * keeps their ids on the job. null = nothing to do.
 */
export async function claimJob(
  pool: pg.Pool,
  workerId: string,
  leaseSeconds: number,
): Promise<{ job: DistillJob; episode: DistillEpisode; related: RelatedFact[] } | null> {
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
    let claimed: (DistillJob & { episode_id: string }) | undefined;
    let episode: (DistillEpisode & { user_id: string | null }) | undefined;
    for (;;) {
      const { rows } = await client.query<DistillJob & { episode_id: string }>(
        `update distill_jobs
         set status = 'claimed', attempts = attempts + 1, claimed_by = $1,
             lease_until = now() + make_interval(secs => $2)
         where id = (select id from distill_jobs where status = 'queued' order by priority desc, created_at, id limit 1 for update skip locked)
         returning id, attempts, lease_until, episode_id`,
        [workerId, leaseSeconds],
      );
      claimed = rows[0];
      if (!claimed) break;
      episode = (
        await client.query<DistillEpisode & { user_id: string | null }>(
          `select e.id, e.kind, e.repo_key, e.content, e.user_id, ${REMEMBER_SQL} as remember_request,
                  case when ${REMEMBER_SQL} and e.user_id is not null then 'personal:' || e.user_id end as personal_scope
           from episodes e where e.id = $1`,
          [claimed.episode_id],
        )
      ).rows[0];
      if (!episode) break;
      // A session (or plain turn) where the person only asked questions has nothing to quote: done with no model call.
      // Never an asf_dialog (a person's note) or a remember job (the person asked for it).
      const skippable = episode.kind === "session" || (episode.kind === "turn" && !episode.remember_request);
      if (!skippable || !questionsOnly(episode.content)) break;
      await client.query(`update distill_jobs set status = 'done', finished_at = now(), lease_until = null, result = $2 where id = $1`, [
        claimed.id,
        { created: [], anchored: [], skipped: "questions only" },
      ]);
    }
    let related: RelatedFact[] = [];
    if (claimed && episode && !episode.remember_request && episode.kind !== "asf_run") {
      related = (
        await client.query<RelatedFact>(
          `select f.id, f.text, f.kind, f.scope from episodes e join facts f on f.status = 'active' and f.scope = any($2::text[])
           where e.id = $1 and case when e.embedding is not null then f.embedding is not null
                                    else ts_rank(e.content_tsv, ${FACT_TSQUERY}) > 0 end
           order by case when e.embedding is not null then f.embedding <=> e.embedding end,
                    case when e.embedding is null then ts_rank(e.content_tsv, ${FACT_TSQUERY}) end desc, f.id
           limit $3`,
          [episode.id, episodeScopes(episode.repo_key, episode.user_id), RELATED_MAX],
        )
      ).rows;
    }
    if (claimed) {
      await client.query("update distill_jobs set related_ids = $2::uuid[] where id = $1", [claimed.id, related.map((f) => f.id)]);
    }
    await client.query("commit");
    if (!claimed || !episode) return null;
    const { user_id: _, ...ep } = episode;
    // A remember job keeps its whole turn (its quote may come from anywhere in it); an asf_run has no user turns.
    if (!ep.remember_request && ep.kind !== "asf_run") ep.content = distillView(ep.content);
    return {
      job: { id: claimed.id, attempts: claimed.attempts, lease_until: new Date(claimed.lease_until).toISOString() },
      episode: ep,
      related,
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
 * Store a claimed job's distilled facts. A fact whose quote is not in the episode, or (except on a remember
 * job or a legacy asf_run job) not in one of its `user:` turns, or whose scope the episode can't speak for, is
 * dropped. A fact already known (same text, or cosine > 0.92 in its scope, or anchored on the same quote in its
 * scope with cosine >= 0.80, or, with no vector on either side, the same exchange) gains an anchor to this episode
 * instead of a new row; the rest become `distilled` candidates. The quote rule also matches a rejected (`retracted`)
 * fact, which gains the anchor and stays retracted, so it isn't sent back for review. A new candidate keeps a
 * `replaces` as `metadata.replaces` when it names a fact the claim sent (`related_ids`) in the candidate's scope.
 *
 * A remember job (a flagged turn) records what the user asked for. Its facts are `authored`, by the
 * episode's instance, with the status a remember from that instance would get, and marked `asked`.
 * The agent may have remembered it already during the turn: a fact that instance wrote in the turn's
 * window counts as the same one (by cosine once embedded here; with no vector, the window fact in that
 * scope), so it gains an anchor and `asked` instead of a twin.
 * null = no such job; ConflictError = the caller does not hold the claim.
 */
export async function completeJob(
  pool: pg.Pool,
  jobId: string,
  worker: Instance,
  input: { facts: DistilledFact[]; usage: DistillUsage },
  embedder: Embedder | null,
): Promise<DistillResult | null> {
  const pre = await pool.query<
    OwnedJob & {
      episode_id: string;
      kind: string;
      content: string;
      repo_key: string | null;
      user_id: string | null;
      remember: boolean;
      role: Instance["role"] | null;
    }
  >(
    `select j.status, j.claimed_by, j.attempts, j.episode_id, e.kind, e.content, e.repo_key, e.user_id,
            ${REMEMBER_SQL} as remember, i.role
     from distill_jobs j join episodes e on e.id = j.episode_id left join instances i on i.id = e.instance_id
     where j.id = $1`,
    [jobId],
  );
  const ep = pre.rows[0];
  if (!ep) return null;
  assertOwned(ep, worker);

  const result: DistillResult = {
    prompt_version: DISTILL_PROMPT_VERSION,
    created: [],
    anchored: [],
    dropped: [],
    dropped_non_user_quote: 0,
  };
  const allowed = new Set(episodeScopes(ep.repo_key, ep.user_id));
  const episodeText = normalizeText(ep.content);
  // A session fact must come from what the person said; a remember job keeps any quote from its turn, and an
  // asf_run record has no user turns.
  const turns = ep.remember || ep.kind === "asf_run" ? null : userTurns(ep.content).map(normalizeText);
  const kept: (DistilledFact & { text: string })[] = [];
  for (const f of input.facts) {
    const quote = normalizeText(f.quote);
    if (!quote || !episodeText.includes(quote)) result.dropped.push({ text: f.text, reason: "quote_not_in_episode" });
    else if (turns && !turns.some((t) => t.includes(quote))) {
      result.dropped.push({ text: f.text, reason: "non_user_quote" });
      result.dropped_non_user_quote++;
    } else if (!allowed.has(f.scope)) result.dropped.push({ text: f.text, reason: "scope_not_allowed" });
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

  // A remember job's window: from the previous turn of this session by the same instance (or 15 minutes
  // back) to the flagged turn. The instance's facts from it may not be embedded yet: embed them now.
  let windowFacts: { id: string; scope: string }[] = [];
  if (ep.remember) {
    const win = await pool.query<{ id: string; text: string; scope: string; unembedded: boolean }>(
      `select f.id, f.text, f.scope, f.embedding is null as unembedded
       from episodes e join facts f on f.author_instance_id = e.instance_id
       where e.id = $1 and f.status in ('candidate', 'active') and f.recorded_at <= e.created_at
         and f.recorded_at >= coalesce(
           (select max(p.created_at) from episodes p
            where p.kind = 'turn' and p.session_id = e.session_id and p.instance_id = e.instance_id and p.created_at < e.created_at),
           e.created_at - interval '15 minutes')
       order by f.recorded_at, f.id`,
      [ep.episode_id],
    );
    windowFacts = win.rows;
    const todo = win.rows.filter((f) => f.unembedded);
    if (embedder && todo.length) {
      try {
        const vecs = (await embedder.embed(todo.map((f) => f.text), "document")).vectors.map(toPgVector);
        for (let i = 0; i < todo.length; i++) {
          await pool.query("update facts set embedding = $2::vector where id = $1 and embedding is null", [todo[i]!.id, vecs[i]]);
        }
      } catch {
        // the embed worker fills them in later; the no-vector fallback below still finds them
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query<OwnedJob & { episode_id: string; author_instance_id: string | null; related_ids: string[] }>(
      `select j.status, j.claimed_by, j.attempts, j.episode_id, e.instance_id as author_instance_id, j.related_ids
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
      if (!factId) {
        // Same words quoted again (the same gate note under two refs, say): a fact anchored on this quote in the
        // scope is the same one when close enough, or, with no vector on either side, when it answers the same question.
        // A rejected (retracted) fact counts too, so the curator's no isn't sent back for review; a superseded one doesn't.
        const quote = normalizeText(f.quote);
        const same = await client.query<{ id: string; cos: number | null; content: string; quote: string }>(
          `select f.id, case when f.embedding is null or $3::vector is null then null else 1 - (f.embedding <=> $3::vector) end as cos,
                  e.content, a.quote
           from facts f join anchors a on a.fact_id = f.id join episodes e on e.id = a.episode_id
           where f.scope = $1 and f.status in ('candidate', 'active', 'retracted') and btrim(regexp_replace(a.quote, '\\s+', ' ', 'g')) = $2
           order by cos desc nulls last, f.recorded_at, f.id`,
          [f.scope, quote, vec],
        );
        const said = (content: string, q: string) => {
          const x = exchangeFor(content, q);
          return x && JSON.stringify([x.assistant === null ? null : normalizeText(x.assistant), normalizeText(x.user)]);
        };
        const mine = said(ep.content, f.quote);
        factId = same.rows.find((r) => {
          if (normalizeText(r.quote) !== quote) return false;
          if (r.cos !== null) return r.cos >= QUOTE_DUPE_MIN;
          return mine !== null && said(r.content, r.quote) === mine;
        })?.id;
      }
      if (!factId && !vec && ep.remember) {
        const same = windowFacts.filter((w) => w.scope === f.scope);
        factId = (same.find((w) => !result.anchored.includes(w.id)) ?? same[0])?.id;
      }
      if (factId) {
        result.anchored.push(factId);
        if (ep.remember) await client.query(`update facts set metadata = metadata || '{"asked":true}' where id = $1`, [factId]);
      } else if (ep.remember) {
        const status = initialStatus("authored", f.scope, ep.role ?? "member");
        const ins = await client.query<{ id: string }>(
          `insert into facts (text, kind, scope, locus, origin, status, author_user_id, author_instance_id, content_hash, embedding, metadata)
           values ($1, $2, $3, $4, 'authored', $5, $6, $7, $8, $9::vector, '{"asked":true}')
           returning id`,
          [f.text, f.kind, f.scope, f.locus ?? [], status, ep.user_id, job.author_instance_id, hash, vec],
        );
        factId = ins.rows[0]!.id;
        result.created.push(factId);
        if (status === "active" && ep.role === "curator" && !f.scope.startsWith("personal:")) {
          await client.query(
            `insert into reviews (fact_id, reviewer_user_id, action, note) values ($1, $2, 'approve', 'authored by curator')`,
            [factId, ep.user_id],
          );
        }
      } else {
        // `replaces` must be a fact the claim sent, in this fact's scope; anything else is dropped without a word.
        const replaces =
          f.replaces && job.related_ids.includes(f.replaces)
            ? (await client.query<{ id: string }>("select id from facts where id = $1 and scope = $2", [f.replaces, f.scope])).rows[0]?.id
            : undefined;
        const ins = await client.query<{ id: string }>(
          `insert into facts (text, kind, scope, locus, origin, status, author_user_id, author_instance_id, content_hash, embedding, metadata)
           values ($1, $2, $3, $4, 'distilled', 'candidate', $5, $6, $7, $8::vector, $9)
           returning id`,
          [f.text, f.kind, f.scope, f.locus ?? [], ep.user_id, job.author_instance_id, hash, vec, replaces ? { replaces } : {}],
        );
        factId = ins.rows[0]!.id;
        result.created.push(factId);
        if (replaces) await flagIfCited(client, ep, job.episode_id, replaces, factId, f.quote);
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

/**
 * A new candidate replaces fact `target`: when an answer cited it before the person said the quoted line, the
 * person corrected it, so flag it (see flagCorrection). In a session or asf_dialog, `[hive:<target's first 8>`
 * appears in the content before that user turn; in a turn, the previous turn (same session and instance) cited it.
 */
async function flagIfCited(
  client: pg.PoolClient,
  ep: { kind: string; content: string },
  episodeId: string,
  target: string,
  candidateId: string,
  quote: string,
): Promise<void> {
  const said = quotedUserTurn(ep.content, quote);
  if (!said) return;
  let cited = false;
  if (ep.kind === "turn") {
    const prev = await client.query<{ cited: unknown }>(
      `select p.metadata->'cited' as cited from episodes e join episodes p
         on p.kind = 'turn' and p.session_id = e.session_id and p.instance_id = e.instance_id and p.created_at < e.created_at
       where e.id = $1 order by p.created_at desc, p.id desc limit 1`,
      [episodeId],
    );
    const list = prev.rows[0]?.cited;
    cited = Array.isArray(list) && list.some((c) => typeof c === "string" && target.startsWith(c.toLowerCase()));
  } else {
    cited = ep.content.slice(0, said.start).toLowerCase().includes(`[hive:${target.slice(0, 8)}`);
  }
  if (cited) await flagCorrection(client, target, { text: said.text, episode_id: episodeId, candidate_id: candidateId });
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
