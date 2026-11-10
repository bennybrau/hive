/**
 * Playbooks: a short procedure for a class of task in a repo — when it applies (path globs, task words), its steps
 * and pitfalls, each linked to the facts it came from. Curators write them; the brief includes the best match.
 * Editing inserts a new active row that supersedes the old one, so the history stays.
 */
import type pg from "pg";
import { estimateTokens } from "./brief.js";

export const PLAYBOOK_STATUSES = ["active", "superseded", "retracted"] as const;
/** Most a playbook may cost in a brief; longer ones lose steps from the end, then pitfalls. */
export const PLAYBOOK_MAX_TOKENS = 300;

export interface PlaybookItem {
  text: string;
  fact_ids: string[];
}
export interface Playbook {
  id: string;
  scope: string;
  title: string;
  applies_paths: string[];
  applies_words: string[];
  steps: PlaybookItem[];
  pitfalls: PlaybookItem[];
  status: (typeof PLAYBOOK_STATUSES)[number];
  supersedes: string | null;
  author_user_id: string | null;
  created_at: string;
}
export interface PlaybookInput {
  scope: string;
  title: string;
  applies_paths?: string[];
  applies_words?: string[];
  steps?: { text: string; fact_ids?: string[] }[];
  pitfalls?: { text: string; fact_ids?: string[] }[];
}
/** What the brief sends: just enough to follow it. */
export interface BriefPlaybook {
  id: string;
  title: string;
  scope: string;
  steps: PlaybookItem[];
  pitfalls: PlaybookItem[];
}

export class PlaybookError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export const PLAYBOOK_COLUMNS =
  "id, scope, title, applies_paths, applies_words, steps, pitfalls, status, supersedes, author_user_id, created_at";

const items = (list: PlaybookInput["steps"]): PlaybookItem[] => (list ?? []).map((i) => ({ text: i.text, fact_ids: i.fact_ids ?? [] }));

/** Every fact a step or pitfall links to must exist; a 400 lists the ones that don't. */
export async function validateFactIds(db: pg.Pool | pg.PoolClient, input: Pick<PlaybookInput, "steps" | "pitfalls">): Promise<void> {
  const ids = [...new Set([...items(input.steps), ...items(input.pitfalls)].flatMap((i) => i.fact_ids))];
  if (!ids.length) return;
  const { rows } = await db.query<{ id: string }>("select id from facts where id = any($1::uuid[])", [ids]);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new PlaybookError(400, `unknown fact ids: ${missing.join(", ")}`);
}

async function insertPlaybook(db: pg.Pool | pg.PoolClient, input: PlaybookInput, author: string, supersedes: string | null): Promise<Playbook> {
  const { rows } = await db.query<Playbook>(
    `insert into playbooks (scope, title, applies_paths, applies_words, steps, pitfalls, supersedes, author_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${PLAYBOOK_COLUMNS}`,
    [
      input.scope, input.title, input.applies_paths ?? [], input.applies_words ?? [],
      JSON.stringify(items(input.steps)), JSON.stringify(items(input.pitfalls)), supersedes, author,
    ],
  );
  return rows[0]!;
}

export async function createPlaybook(pool: pg.Pool, input: PlaybookInput, author: string): Promise<Playbook> {
  await validateFactIds(pool, input);
  return insertPlaybook(pool, input, author, null);
}

export async function getPlaybook(pool: pg.Pool, id: string): Promise<Playbook | null> {
  const { rows } = await pool.query<Playbook>(`select ${PLAYBOOK_COLUMNS} from playbooks where id = $1`, [id]);
  return rows[0] ?? null;
}

/** Active playbooks, newest first; optionally in one scope. */
export async function listPlaybooks(pool: pg.Pool, scope?: string): Promise<Playbook[]> {
  const { rows } = await pool.query<Playbook>(
    `select ${PLAYBOOK_COLUMNS} from playbooks where status = 'active' and ($1::text is null or scope = $1)
     order by created_at desc, id`,
    [scope ?? null],
  );
  return rows;
}

/** A new version of an active playbook: fields left out keep the old row's values. */
export async function updatePlaybook(pool: pg.Pool, id: string, input: Partial<PlaybookInput>, author: string): Promise<Playbook> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<Playbook>(`select ${PLAYBOOK_COLUMNS} from playbooks where id = $1 for update`, [id]);
    const old = rows[0];
    if (!old) throw new PlaybookError(404, "no such playbook");
    if (old.status !== "active") throw new PlaybookError(409, `playbook is ${old.status}, not active`);
    const next: PlaybookInput = {
      scope: input.scope ?? old.scope,
      title: input.title ?? old.title,
      applies_paths: input.applies_paths ?? old.applies_paths,
      applies_words: input.applies_words ?? old.applies_words,
      steps: input.steps ?? old.steps,
      pitfalls: input.pitfalls ?? old.pitfalls,
    };
    await validateFactIds(client, next);
    const created = await insertPlaybook(client, next, author, old.id);
    await client.query("update playbooks set status = 'superseded' where id = $1", [old.id]);
    await client.query("commit");
    return created;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function retractPlaybook(pool: pg.Pool, id: string): Promise<Playbook> {
  const { rows } = await pool.query<Playbook>(
    `update playbooks set status = 'retracted' where id = $1 and status = 'active' returning ${PLAYBOOK_COLUMNS}`,
    [id],
  );
  if (rows[0]) return rows[0];
  const existing = await getPlaybook(pool, id);
  if (!existing) throw new PlaybookError(404, "no such playbook");
  throw new PlaybookError(409, `playbook is ${existing.status}, not active`);
}

/** `**` = any characters including `/` (`**\/` also matches no folder), `*` = any except `/`, `?` = one except `/`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The active playbook in global, repo:<key> or one of the extra repos that best fits the task: most changed paths
 * matching its globs, then most of its words in the task, then the repo's own over an extra repo's over a global one,
 * then the newest. No hits at all -> null.
 */
export async function bestPlaybook(
  pool: pg.Pool, repoKey: string, task: string, changedPaths: string[], alsoRepos: string[] = [],
): Promise<Playbook | null> {
  const main = `repo:${repoKey}`;
  const { rows } = await pool.query<Playbook>(
    `select ${PLAYBOOK_COLUMNS} from playbooks where status = 'active' and (scope = 'global' or scope = any($1))`,
    [[main, ...alsoRepos.map((k) => `repo:${k}`)]],
  );
  const ranked = rows
    .map((p) => {
      const globs = p.applies_paths.map(globToRegExp);
      const pathHits = changedPaths.filter((cp) => globs.some((g) => g.test(cp))).length;
      const wordHits = p.applies_words.filter((w) => w.trim() && new RegExp(`\\b${escapeRegExp(w.trim())}\\b`, "i").test(task)).length;
      const own = p.scope === main ? 2 : p.scope === "global" ? 0 : 1;
      return { p, pathHits, wordHits, own, at: new Date(p.created_at).getTime() };
    })
    .filter((r) => r.pathHits + r.wordHits > 0)
    .sort((a, b) => b.pathHits - a.pathHits || b.wordHits - a.wordHits || b.own - a.own || b.at - a.at);
  return ranked[0]?.p ?? null;
}

/** The brief's view of a playbook, cut to `max` tokens: steps go from the end first, then pitfalls. */
export function trimPlaybook(p: Pick<Playbook, "id" | "title" | "scope" | "steps" | "pitfalls">, max = PLAYBOOK_MAX_TOKENS): BriefPlaybook {
  const out: BriefPlaybook = { id: p.id, title: p.title, scope: p.scope, steps: [...p.steps], pitfalls: [...p.pitfalls] };
  while (estimateTokens(out) > max && out.steps.length) out.steps.pop();
  while (estimateTokens(out) > max && out.pitfalls.length) out.pitfalls.pop();
  return out;
}
