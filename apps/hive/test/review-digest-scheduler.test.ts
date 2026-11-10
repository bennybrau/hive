import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { createFact } from "../src/facts.js";
import { saveReviewDigestConfig, type ReviewDigestConfig } from "../src/review-digest/config.js";
import { digestTick, localNow, startReviewDigestScheduler } from "../src/review-digest/scheduler.js";
import { freshDb } from "./helpers.js";

const KEY = randomBytes(32);
const BOT_TOKEN = "123456:BOT-SUPERSECRET-token";
const TZ = "America/Chicago";

/** A fake Telegram Bot API: records each request and answers from `replies` (then 200 ok). */
let telegram: Server;
let telegramUrl: string;
let telegramReqs: { path: string; body: Record<string, unknown> }[];
let telegramReplies: { status: number; body: unknown }[];

let pool: pg.Pool;
let curator: { instance: Instance; token: string };

beforeAll(async () => {
  telegram = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      telegramReqs.push({ path: req.url ?? "", body: JSON.parse(raw) });
      const reply = telegramReplies.shift() ?? { status: 200, body: { ok: true, result: {} } };
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => telegram.listen(0, "127.0.0.1", r));
  telegramUrl = `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`;
  pool = await freshDb();
});
afterAll(async () => {
  await new Promise((r) => telegram.close(r));
  await pool.end();
});
beforeEach(async () => {
  telegramReqs = [];
  telegramReplies = [];
  await pool.query("truncate settings, review_digests, reviews, anchors, facts, episodes, instances cascade");
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
});

const save = (cfg: Partial<ReviewDigestConfig> = {}) =>
  saveReviewDigestConfig(
    pool,
    KEY,
    {
      enabled: true,
      time: "18:00",
      timezone: TZ,
      dashboard_url: "https://hive.example.com/",
      email: null,
      telegram: { bot_token: BOT_TOKEN, chat_id: "-100123" },
      ...cfg,
    },
    "jon",
  );

/** One candidate in jon's review queue. */
async function candidate() {
  const { fact } = await createFact(pool, { text: "The export runs nightly.", kind: "decision", scope: "global", origin: "authored" }, curator.instance);
  await pool.query("update facts set status = 'candidate', recorded_at = '2026-11-01T12:00:00Z' where id = $1", [fact.id]);
}

const tick = (now: Date) => digestTick(pool, KEY, { now, telegramApiUrl: telegramUrl });
/** Nov 2026 in Chicago is CST, UTC-6. */
const cst = (date: string, time: string) => new Date(`${date}T${time}:00-06:00`);
const rows = async () =>
  (
    await pool.query<{ local_date: string; item_count: number; telegram_status: string | null; telegram_error: string | null; attempts: number; sent_at: Date | null }>(
      "select to_char(local_date, 'YYYY-MM-DD') as local_date, item_count, telegram_status, telegram_error, attempts, sent_at from review_digests order by local_date",
    )
  ).rows;

/** Ticks every 10 minutes over [from, to). */
async function sweep(from: string, to: string) {
  for (let t = Date.parse(from); t < Date.parse(to); t += 10 * 60_000) await tick(new Date(t));
}

describe("localNow", () => {
  it("gives the local date and 24-hour time", () => {
    expect(localNow(new Date("2026-11-11T00:00:00Z"), TZ)).toEqual({ date: "2026-11-10", time: "18:00" });
    expect(localNow(new Date("2026-11-10T06:05:00Z"), TZ)).toEqual({ date: "2026-11-10", time: "00:05" });
  });
});

describe("digestTick", () => {
  beforeEach(async () => {
    await save();
    await candidate();
  });

  it("is not due at 17:59, is at 18:00 and 18:01", async () => {
    await tick(cst("2026-11-10", "17:59"));
    expect(await rows()).toEqual([]);
    expect(telegramReqs).toHaveLength(0);
    await tick(cst("2026-11-10", "18:00"));
    expect(telegramReqs).toHaveLength(1);
    expect(await rows()).toMatchObject([{ local_date: "2026-11-10", item_count: 1, telegram_status: "sent", telegram_error: null, attempts: 1 }]);
    await tick(cst("2026-11-10", "18:01"));
    expect(telegramReqs).toHaveLength(1);
  });

  it("marks as new only what arrived since the last digest that went out", async () => {
    await tick(cst("2026-11-10", "18:00"));
    expect(String(telegramReqs[0]!.body.text).split("\n")[0]).toBe("<b>Hive: 1 fact to review</b>");
    const { fact } = await createFact(pool, { text: "Deploys wait for the nightly export.", kind: "decision", scope: "global", origin: "authored" }, curator.instance);
    await pool.query("update facts set status = 'candidate', recorded_at = $2 where id = $1", [fact.id, cst("2026-11-10", "20:00")]);
    await tick(cst("2026-11-11", "18:00"));
    const text = String(telegramReqs[1]!.body.text);
    expect(text.split("\n")[0]).toBe("<b>Hive: 2 facts to review (1 new)</b>");
    expect(text).toContain("🆕 Deploys wait for the nightly export.");
    expect(text).not.toContain("🆕 The export runs nightly.");
  });

  it("sends at 18:01 when that is the first tick after the time", async () => {
    await tick(cst("2026-11-10", "18:01"));
    expect(telegramReqs).toHaveLength(1);
  });

  for (const [name, from, to, days] of [
    ["spring forward", "2026-03-07T06:00:00Z", "2026-03-10T05:00:00Z", ["2026-03-07", "2026-03-08", "2026-03-09"]],
    ["fall back", "2026-10-31T05:00:00Z", "2026-11-03T06:00:00Z", ["2026-10-31", "2026-11-01", "2026-11-02"]],
  ] as const) {
    for (const time of ["18:00", "02:30", "01:30"]) {
      it(`sends once a day across ${name} at ${time}`, async () => {
        await save({ time });
        await sweep(from, to);
        expect((await rows()).map((r) => r.local_date)).toEqual(days);
        expect(telegramReqs).toHaveLength(3);
      });
    }
  }

  it("sends once for two ticks in a row, or at once", async () => {
    await tick(cst("2026-11-10", "18:00"));
    await tick(cst("2026-11-10", "18:00"));
    await Promise.all([tick(cst("2026-11-10", "18:05")), tick(cst("2026-11-10", "18:05"))]);
    expect(await rows()).toHaveLength(1);
    expect(telegramReqs).toHaveLength(1);
  });

  it("sends once for two concurrent first ticks", async () => {
    await Promise.all([tick(cst("2026-11-10", "18:00")), tick(cst("2026-11-10", "18:00"))]);
    expect(await rows()).toHaveLength(1);
    expect(telegramReqs).toHaveLength(1);
  });

  it("still sends after a restart at 20:00", async () => {
    await tick(cst("2026-11-10", "20:00"));
    expect(telegramReqs).toHaveLength(1);
    expect((await rows())[0]!.local_date).toBe("2026-11-10");
  });

  it("does not catch up yesterday's digest the next morning", async () => {
    await tick(cst("2026-11-11", "09:00"));
    expect(await rows()).toEqual([]);
    await pool.query(
      `insert into review_digests (local_date, claimed_at, next_attempt_at, telegram_status, telegram_error, attempts, item_count)
       values ('2026-11-10', $1, $1, 'failed', 'down', 1, 1)`,
      [cst("2026-11-10", "18:00")],
    );
    await tick(cst("2026-11-11", "09:00"));
    expect(telegramReqs).toHaveLength(0);
    expect(await rows()).toMatchObject([{ local_date: "2026-11-10", attempts: 1, telegram_status: "failed" }]);
    // Today's digest goes out on time; yesterday's stays as it was.
    await tick(cst("2026-11-11", "18:00"));
    expect(telegramReqs).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { local_date: "2026-11-10", attempts: 1, telegram_status: "failed" },
      { local_date: "2026-11-11", attempts: 1, telegram_status: "sent" },
    ]);
  });

  it("sends nothing for an empty queue", async () => {
    await pool.query("truncate facts cascade");
    await tick(cst("2026-11-10", "18:00"));
    await tick(cst("2026-11-10", "18:30"));
    expect(telegramReqs).toHaveLength(0);
    expect(await rows()).toMatchObject([{ local_date: "2026-11-10", item_count: 0, telegram_status: null, sent_at: null }]);
  });

  it("retries a failed channel after a minute and shows the error meanwhile", async () => {
    telegramReplies = [{ status: 500, body: { ok: false, description: "Internal Server Error" } }];
    const app = buildApp(pool, { version: "test", secretKey: KEY });
    const lastError = async () =>
      (await app.inject({ url: "/v1/settings", headers: { authorization: `Bearer ${curator.token}` } })).json().review_digest.last_error;

    await tick(cst("2026-11-10", "18:00"));
    expect(await rows()).toMatchObject([{ telegram_status: "failed", telegram_error: "Internal Server Error", attempts: 1, sent_at: null }]);
    expect(await lastError()).toBe("telegram: Internal Server Error");
    await tick(new Date(cst("2026-11-10", "18:00").getTime() + 59_000));
    expect(telegramReqs).toHaveLength(1);

    await tick(cst("2026-11-10", "18:01"));
    expect(telegramReqs).toHaveLength(2);
    expect(await rows()).toMatchObject([{ telegram_status: "sent", telegram_error: null, attempts: 2 }]);
    expect((await rows())[0]!.sent_at).toEqual(cst("2026-11-10", "18:01"));
    expect(await lastError()).toBeNull();
    await app.close();
  });

  it("gives up after 4 attempts", async () => {
    const bad = { status: 500, body: { ok: false, description: "down" } };
    telegramReplies = Array(10).fill(bad);
    for (const time of ["18:00", "18:01", "18:06", "18:21", "18:36", "19:00", "23:59"]) await tick(cst("2026-11-10", time));
    expect(telegramReqs).toHaveLength(4);
    expect(await rows()).toMatchObject([{ telegram_status: "failed", attempts: 4 }]);
  });

  it("runs ticks in the background and stops", async () => {
    await save({ time: "00:00" });
    const s = startReviewDigestScheduler(pool, KEY, { intervalMs: 20, telegramApiUrl: telegramUrl });
    await expect.poll(() => telegramReqs.length, { timeout: 3000 }).toBe(1);
    await s.stop();
  });

  it("skips when disabled, without a channel, or saved under another key", async () => {
    await save({ enabled: false });
    await tick(cst("2026-11-10", "18:00"));
    await save({ telegram: null });
    await tick(cst("2026-11-10", "18:00"));
    await saveReviewDigestConfig(
      pool,
      randomBytes(32),
      { enabled: true, time: "18:00", timezone: TZ, dashboard_url: "https://x.example", email: null, telegram: { bot_token: BOT_TOKEN, chat_id: "1" } },
      "jon",
    );
    await tick(cst("2026-11-10", "18:00"));
    expect(await rows()).toEqual([]);
    expect(telegramReqs).toHaveLength(0);
  });
});
