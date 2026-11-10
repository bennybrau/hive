import type pg from "pg";
import { loadReviewQueueItems } from "../review-queue.js";

/** Items a digest lists; the rest are "and N more". */
export const DIGEST_ITEMS_MAX = 15;
/** Telegram rejects longer messages. */
export const TELEGRAM_MAX = 4096;
const TEXT_MAX = 200;

export interface DigestItem {
  /** `[hive:<first 8 of id>]` */
  ref: string;
  text: string;
  /** Where it applies: everyone, a repo name, or just you. */
  applies: string;
  /** Where it came from, in plain words. */
  source: string;
  /** today, 1 day or N days, in local dates. */
  waiting: string;
  isNew: boolean;
}

export interface Digest {
  total: number;
  newCount: number;
  items: DigestItem[];
  more: number;
  dashboard_url: string;
}

export interface DigestInput {
  user_id: string;
  timezone: string;
  dashboard_url: string;
  /** Items asked after this are new; null = since the start of today, local. */
  since: Date | null;
  now: Date;
}

/**
 * What a curator's review digest says: the review queue as they would see it (same scopes and order), candidates
 * first then flagged facts, the first DIGEST_ITEMS_MAX of them in plain words.
 */
export async function buildDigest(pool: pg.Pool, input: DigestInput): Promise<Digest> {
  const { candidates, flagged } = await loadReviewQueueItems(pool, { user_id: input.user_id });
  const all = [
    ...candidates.map((c) => ({ fact: c, at: new Date(c.recorded_at), flag: null as string | null })),
    ...flagged.map((f) => ({ fact: f, at: new Date(f.correction.at), flag: f.correction.text })),
  ];
  const newAfter = input.since ?? startOfLocalDay(input.now, input.timezone);
  const shown = all.slice(0, DIGEST_ITEMS_MAX);

  // The conversation each shown distilled candidate was quoted from: a factory run wins over a chat.
  const { rows: episodes } = await pool.query<{ fact_id: string; kind: string; user_id: string | null }>(
    `select a.fact_id, e.kind, e.user_id from anchors a join episodes e on e.id = a.episode_id
     where a.fact_id = any($1::uuid[])
     order by a.fact_id, e.kind = 'asf_run' desc, e.user_id is null, e.created_at`,
    [shown.filter((i) => i.flag === null).map((i) => i.fact.id)],
  );
  const episodeOf = new Map<string, { kind: string; user_id: string | null }>();
  for (const e of episodes) if (!episodeOf.has(e.fact_id)) episodeOf.set(e.fact_id, e);

  const today = localDate(input.now, input.timezone);
  const items = shown.map(({ fact, at, flag }): DigestItem => {
    let source: string;
    const ep = episodeOf.get(fact.id);
    if (flag !== null) source = `flagged: ${cut(flag)}`;
    else if (fact.origin === "distilled" && ep?.kind === "asf_run") source = "from a factory run";
    else if (fact.origin === "distilled" && ep) source = ep.user_id ? `from a chat with ${ep.user_id}` : "from a chat";
    else source = fact.author_user_id ? `written by ${fact.author_user_id}` : "written by someone";
    const days = Math.max(0, Math.round((today - localDate(at, input.timezone)) / 86_400_000));
    return {
      ref: `[hive:${fact.id.slice(0, 8)}]`,
      text: cut(fact.text),
      applies: appliesTo(fact.scope),
      source,
      waiting: days === 0 ? "today" : days === 1 ? "1 day" : `${days} days`,
      isNew: at > newAfter,
    };
  });
  return {
    total: all.length,
    newCount: all.filter((i) => i.at > newAfter).length,
    items,
    more: all.length - items.length,
    dashboard_url: input.dashboard_url.replace(/\/+$/, ""),
  };
}

function appliesTo(scope: string): string {
  if (scope === "global") return "everyone";
  if (scope.startsWith("personal:")) return "just you";
  if (scope.startsWith("repo:")) return scope.slice(5).split("/").pop() || scope.slice(5);
  return scope;
}

function cut(text: string, max = TEXT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Midnight UTC of the local calendar date `d` falls on in `timeZone`, as ms (for counting whole days). */
function localDate(d: Date, timeZone: string): number {
  const [y, m, day] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d)
    .split("-")
    .map(Number);
  return Date.UTC(y!, m! - 1, day!);
}

/** How far `timeZone` is ahead of UTC at `d`, in ms. */
function offsetAt(d: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(d).map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

function startOfLocalDay(now: Date, timeZone: string): Date {
  const midnight = localDate(now, timeZone);
  const guess = midnight - offsetAt(now, timeZone);
  return new Date(midnight - offsetAt(new Date(guess), timeZone));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function headline(d: Digest): string {
  if (d.total === 0) return "Hive: Nothing to review";
  const facts = d.total === 1 ? "1 fact" : `${d.total} facts`;
  return `Hive: ${facts} to review${d.newCount ? ` (${d.newCount} new today)` : ""}`;
}

function details(i: DigestItem): string {
  return `${i.applies} · ${i.source} · ${i.waiting === "today" ? "added today" : `waiting ${i.waiting}`}`;
}

function andMore(n: number): string {
  return `and ${n} more`;
}

/** The digest as a Telegram message (HTML parse mode), never longer than TELEGRAM_MAX. */
export function renderTelegram(d: Digest): string {
  const link = `<a href="${esc(`${d.dashboard_url}/review`)}">Open the review queue</a>`;
  const build = (n: number) => {
    const parts = [`<b>${esc(headline(d))}</b>`];
    for (const i of d.items.slice(0, n)) {
      parts.push(`${i.isNew ? "🆕 " : ""}${esc(i.text)} ${esc(i.ref)}\n<i>${esc(details(i))}</i>`);
    }
    const more = d.more + d.items.length - n;
    if (more > 0) parts.push(andMore(more));
    parts.push(link);
    return parts.join("\n\n");
  };
  for (let n = d.items.length; n > 0; n--) {
    const msg = build(n);
    if (msg.length <= TELEGRAM_MAX) return msg;
  }
  return build(0);
}

/** The digest as an email: subject, plain text, and HTML that holds up in a phone's mail app (tables, inline styles). */
export function renderEmail(d: Digest): { subject: string; text: string; html: string } {
  const subject = headline(d);
  const url = `${d.dashboard_url}/review`;
  const text = [
    subject,
    ...d.items.map((i) => `${i.isNew ? "[new] " : ""}${i.text} ${i.ref}\n  ${details(i)}`),
    ...(d.more ? [andMore(d.more)] : []),
    `Review them: ${url}`,
  ].join("\n\n");

  const cell = 'style="padding:12px 16px;border-bottom:1px solid #e5e5e5;font-family:Arial,sans-serif;font-size:15px;line-height:1.4;color:#222;"';
  const rows = d.items.map(
    (i) =>
      `<tr><td ${cell}>${i.isNew ? '<span style="color:#0a7d32;font-weight:bold;">new</span> ' : ""}${esc(i.text)} ` +
      `<span style="color:#888;">${esc(i.ref)}</span><br>` +
      `<span style="font-size:13px;color:#666;">${esc(details(i))}</span></td></tr>`,
  );
  if (d.more) rows.push(`<tr><td ${cell}>${esc(andMore(d.more))}</td></tr>`);
  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;border-collapse:collapse;">' +
    `<tr><td style="padding:16px;font-family:Arial,sans-serif;font-size:18px;font-weight:bold;color:#111;">${esc(subject)}</td></tr>` +
    rows.join("") +
    `<tr><td style="padding:16px;font-family:Arial,sans-serif;font-size:15px;">` +
    `<a href="${esc(url)}" style="color:#1a5fb4;font-weight:bold;">Open the review queue</a></td></tr>` +
    "</table>";
  return { subject, text, html };
}
