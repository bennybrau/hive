import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact, type FactInput } from "../src/facts.js";
import { buildDigest, renderEmail, renderTelegram, TELEGRAM_MAX, type Digest, type DigestItem } from "../src/review-digest/content.js";
import { freshDb } from "./helpers.js";

const REPO = "gh/acme/api";
const TZ = "Europe/Berlin";
// 10:00 in Berlin; local midnight is 23:00 UTC the day before.
const NOW = new Date("2026-11-10T09:00:00Z");
const URL = "https://hive.example.com/";

let pool: pg.Pool;
let curator: Instance;
let alice: Instance;

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate settings, llm_calls, reviews, anchors, facts, episodes, distill_jobs, repos, instances cascade");
  curator = (await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" })).instance;
  alice = (await createInstance(pool, { name: "alice-laptop", userId: "alice" })).instance;
});

const digest = (since: Date | null = null) =>
  buildDigest(pool, { user_id: "jon", timezone: TZ, dashboard_url: URL, since, now: NOW });

let n = 0;
/** A candidate recorded at `at`, optionally quoted from an episode of `episode.kind` by `episode.user_id`. */
async function candidate(
  at: string,
  opts: Partial<FactInput> & { text?: string; episode?: { kind: string; user_id: string | null } } = {},
  who = alice,
) {
  const { episode, ...input } = opts;
  const { fact } = await createFact(
    pool,
    { text: `The export runs nightly (${++n}).`, kind: "decision", scope: `repo:${REPO}`, origin: "distilled", ...input },
    who,
  );
  await pool.query("update facts set status = 'candidate', recorded_at = $2 where id = $1", [fact.id, at]);
  if (episode) {
    const ep = await pool.query<{ id: string }>(
      "insert into episodes (kind, user_id, content) values ($1, $2, 'user: hi') returning id",
      [episode.kind, episode.user_id],
    );
    await pool.query("insert into anchors (fact_id, episode_id, quote) values ($1, $2, 'hi')", [fact.id, ep.rows[0]!.id]);
  }
  return fact.id;
}

async function flagged(at: string, text: string) {
  const { fact } = await createFact(pool, { text: `Deploys go out on Fridays (${++n}).`, kind: "convention", scope: "global", origin: "authored" }, curator);
  await pool.query("update facts set metadata = $2 where id = $1", [
    fact.id,
    { correction: { text, episode_id: fact.id, candidate_id: null, at } },
  ]);
  return fact.id;
}

describe("buildDigest", () => {
  it("leaves out another user's personal candidate and counts flagged facts", async () => {
    await candidate("2026-11-09T08:00:00Z", { scope: "personal:alice", text: "Alice prefers tabs." });
    const mine = await candidate("2026-11-09T08:00:00Z", { scope: "personal:jon" }, curator);
    await candidate("2026-11-09T09:00:00Z");
    const flag = await flagged("2026-11-10T08:00:00Z", "No, deploys are on <Thursdays> & never Fridays.");
    const d = await digest();
    expect(d.total).toBe(3);
    expect(d.items.map((i) => i.text)).not.toContain("Alice prefers tabs.");
    expect(d.items[0]).toMatchObject({ ref: `[hive:${mine.slice(0, 8)}]`, applies: "just you" });
    expect(d.items[1]!.applies).toBe("api");
    expect(d.items[2]).toMatchObject({
      ref: `[hive:${flag.slice(0, 8)}]`,
      applies: "everyone",
      source: "flagged: No, deploys are on <Thursdays> & never Fridays.",
    });
    expect(d.more).toBe(0);
    expect(d.dashboard_url).toBe("https://hive.example.com");
  });

  it("marks items new after `since`, or after the start of today (local) when since is null", async () => {
    await candidate("2026-11-09T22:30:00Z"); // 23:30 yesterday in Berlin
    await candidate("2026-11-09T23:30:00Z"); // 00:30 today in Berlin
    await flagged("2026-11-10T08:00:00Z", "wrong");
    const today = await digest(null);
    expect(today.items.map((i) => i.isNew)).toEqual([false, true, true]);
    expect(today.newCount).toBe(2);
    const sinceYesterday = await digest(new Date("2026-11-09T12:00:00Z"));
    expect(sinceYesterday.items.map((i) => i.isNew)).toEqual([true, true, true]);
    expect(sinceYesterday.newCount).toBe(3);
  });

  it("shows 15 of 17 items and counts the rest as more", async () => {
    for (let i = 0; i < 17; i++) await candidate(`2026-11-0${1 + (i % 9)}T08:00:00Z`);
    const d = await digest();
    expect(d.total).toBe(17);
    expect(d.items).toHaveLength(15);
    expect(d.more).toBe(2);
  });

  it("says where each item came from in plain words", async () => {
    await candidate("2026-11-01T08:00:00Z", { episode: { kind: "asf_run", user_id: "jon" } });
    await candidate("2026-11-02T08:00:00Z", { episode: { kind: "turn", user_id: "alice" } });
    await candidate("2026-11-03T08:00:00Z", { origin: "authored" });
    await candidate("2026-11-04T08:00:00Z"); // distilled, no episode
    const d = await digest();
    expect(d.items.map((i) => i.source)).toEqual([
      "from a factory run",
      "from a chat with alice",
      "written by alice",
      "written by alice",
    ]);
  });

  it("cuts a long candidate text and a long flagged correction to about 200 chars", async () => {
    const long = "word ".repeat(60).trim();
    await candidate("2026-11-09T08:00:00Z", { text: long });
    await flagged("2026-11-10T08:00:00Z", long);
    const d = await digest();
    expect(d.items[0]!.text.length).toBeLessThanOrEqual(200);
    expect(d.items[0]!.text.endsWith("…")).toBe(true);
    expect(d.items[1]!.source.length).toBeLessThanOrEqual(200 + "flagged: ".length);
    expect(d.items[1]!.source.endsWith("…")).toBe(true);
  });

  it("counts waiting in local dates: today, 1 day, N days", async () => {
    await candidate("2026-11-09T23:30:00Z"); // today in Berlin, yesterday in UTC
    await candidate("2026-11-09T22:30:00Z"); // yesterday in Berlin
    await candidate("2026-11-06T12:00:00Z");
    const d = await digest();
    expect(d.items.map((i) => i.waiting).sort()).toEqual(["1 day", "4 days", "today"]);
  });
});

const item = (over: Partial<DigestItem> = {}): DigestItem => ({
  ref: "[hive:abcd1234]",
  text: "The export runs nightly.",
  applies: "api",
  source: "from a factory run",
  waiting: "2 days",
  isNew: false,
  ...over,
});
const make = (items: DigestItem[], over: Partial<Digest> = {}): Digest => ({
  total: items.length,
  newCount: items.filter((i) => i.isNew).length,
  items,
  more: 0,
  dashboard_url: "https://hive.example.com",
  ...over,
});

describe("renderers", () => {
  it("escape every dynamic string", () => {
    const d = make([item({ text: "<script>alert(1)</script> & co", source: "flagged: <b>no</b> & yes", isNew: true })]);
    for (const out of [renderTelegram(d), renderEmail(d).html]) {
      expect(out).not.toContain("<script>");
      expect(out).not.toContain("<b>no</b>");
      expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; co");
      expect(out).toContain("flagged: &lt;b&gt;no&lt;/b&gt; &amp; yes");
    }
    expect(renderEmail(d).text).toContain("<script>alert(1)</script> & co");
  });

  it("keeps a Telegram message within 4096 chars, with the count line, 'and N more' and the link", () => {
    const long = "A long fact with <angle> & ampersands ".repeat(6).slice(0, 199) + "…";
    const d = make(Array.from({ length: 15 }, (_, i) => item({ text: long, source: `flagged: ${long}`, isNew: i % 2 === 0 })), {
      total: 20,
      more: 5,
    });
    const msg = renderTelegram(d);
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(msg.startsWith("<b>Hive: 20 facts to review (8 new today)</b>")).toBe(true);
    expect(msg).toContain('<a href="https://hive.example.com/review">');
    const shown = msg.split("[hive:abcd1234]").length - 1;
    expect(shown).toBeLessThan(15);
    expect(msg).toContain(`and ${20 - shown} more`);
  });

  it("read 'Nothing to review' when the queue is empty", () => {
    const d = make([]);
    expect(renderTelegram(d)).toContain("Nothing to review");
    expect(renderTelegram(d)).toContain("/review");
    expect(renderEmail(d).subject).toBe("Hive: Nothing to review");
  });

  it("use singular wording for one fact, and mark new items", () => {
    const d = make([item({ isNew: true, waiting: "today" })]);
    const msg = renderTelegram(d);
    expect(msg.split("\n")[0]).toBe("<b>Hive: 1 fact to review (1 new today)</b>");
    expect(msg).toContain("🆕 The export runs nightly. [hive:abcd1234]");
    expect(msg).toContain("api · from a factory run · added today");
    const email = renderEmail(d);
    expect(email.subject).toBe("Hive: 1 fact to review (1 new today)");
    expect(email.html).toContain(">new</span>");
    expect(email.text).toContain("https://hive.example.com/review");
    expect(renderEmail(make([item(), item()])).subject).toBe("Hive: 2 facts to review");
  });
});
