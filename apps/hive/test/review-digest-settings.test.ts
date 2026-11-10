import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { getReviewDigestConfig } from "../src/review-digest/config.js";
import { freshDb } from "./helpers.js";

const KEY = randomBytes(32);
const SMTP_PASS = "smtp-SUPERSECRET-password";
const BOT_TOKEN = "123456:BOT-SUPERSECRET-token";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const email = (over: Record<string, unknown> = {}) => ({
  smtp_host: "smtp.example.com",
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: "hive",
  smtp_pass: SMTP_PASS,
  from: "hive@example.com",
  to: ["jon@example.com"],
  ...over,
});
const telegram = (over: Record<string, unknown> = {}) => ({ bot_token: BOT_TOKEN, chat_id: "-100123", ...over });
const body = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  dashboard_url: "https://hive.example.com",
  email: email(),
  telegram: telegram(),
  ...over,
});
const put = (a: FastifyInstance, token: string, payload: unknown) =>
  a.inject({ method: "PUT", url: "/v1/settings/review-digest", headers: auth(token), payload: payload as object });
const getDigest = async (a: FastifyInstance, token: string) => {
  const res = await a.inject({ url: "/v1/settings", headers: auth(token) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().review_digest;
};
const expect400 = async (payload: unknown, error?: RegExp) => {
  const res = await put(app, curator.token, payload);
  expect(res.statusCode, res.body).toBe(400);
  if (error) expect(res.json().error).toMatch(error);
};

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate settings, review_digests, instances cascade");
  app = buildApp(pool, { version: "test", secretKey: KEY });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
});
afterEach(async () => {
  await app.close();
});

describe("review digest settings", () => {
  it("is null until set", async () => {
    expect(await getDigest(app, curator.token)).toBeNull();
  });

  it("round-trips with defaults, without secrets", async () => {
    const res = await put(app, curator.token, body());
    expect(res.statusCode, res.body).toBe(204);
    expect(await getDigest(app, curator.token)).toEqual({
      enabled: true,
      time: "18:00",
      timezone: "America/Chicago",
      dashboard_url: "https://hive.example.com",
      channels: {
        email: {
          smtp_host: "smtp.example.com",
          smtp_port: 587,
          smtp_secure: false,
          smtp_user: "hive",
          from: "hive@example.com",
          to: ["jon@example.com"],
        },
        telegram: { chat_id: "-100123" },
      },
      last_sent_at: null,
      last_item_count: null,
      last_error: null,
    });
    const cfg = await getReviewDigestConfig(pool, KEY);
    expect(cfg).toMatchObject({ user_id: "jon", email: { smtp_pass: SMTP_PASS }, telegram: { bot_token: BOT_TOKEN } });
    const { rows } = await pool.query<{ value_enc: Buffer }>("select value_enc from settings where key = 'review_digest'");
    expect(rows[0]!.value_enc.includes(Buffer.from(SMTP_PASS))).toBe(false);
  });

  it("keeps a given time and timezone", async () => {
    expect((await put(app, curator.token, body({ time: "07:05", timezone: "Europe/Berlin" }))).statusCode).toBe(204);
    expect(await getDigest(app, curator.token)).toMatchObject({ time: "07:05", timezone: "Europe/Berlin" });
  });

  it("rejects a bad time", async () => {
    await expect400(body({ time: "24:00" }), /time/);
    await expect400(body({ time: "9:5" }), /time/);
  });

  it("rejects an unknown timezone", async () => {
    await expect400(body({ timezone: "Mars/Olympus" }), /timezone/);
  });

  it("rejects a non-http(s) dashboard URL", async () => {
    await expect400(body({ dashboard_url: "ftp://hive.example.com" }), /dashboard_url/);
    await expect400(body({ dashboard_url: "not a url" }), /dashboard_url/);
  });

  it("rejects bad email addresses", async () => {
    await expect400(body({ email: email({ from: "hive" }) }), /email\.from/);
    await expect400(body({ email: email({ to: ["jon@example.com", "nope"] }) }), /email\.to/);
  });

  it("rejects a bad port, too many or no recipients, and wrong types", async () => {
    await expect400(body({ email: email({ smtp_port: 0 }) }));
    await expect400(body({ email: email({ smtp_port: 65536 }) }));
    await expect400(body({ email: email({ to: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`) }) }));
    await expect400(body({ email: email({ to: [] }) }));
    await expect400(body({ enabled: "yes" }));
    expect((await pool.query("select 1 from settings")).rowCount).toBe(0);
  });

  it("accepts time at the edges of the valid range", async () => {
    expect((await put(app, curator.token, body({ time: "00:00" }))).statusCode).toBe(204);
    expect((await put(app, curator.token, body({ time: "23:59" }))).statusCode).toBe(204);
  });

  it("rejects a body missing required fields", async () => {
    const { dashboard_url: _d, ...noUrl } = body();
    await expect400(noUrl);
    const { enabled: _e, ...noEnabled } = body();
    await expect400(noEnabled);
    const { chat_id: _c, ...telegramNoChatId } = telegram();
    await expect400(body({ telegram: telegramNoChatId }));
  });

  it("rejects an unknown property instead of dropping it", async () => {
    await expect400(body({ foo: "bar" }), /unknown property foo/);
    await expect400(body({ email: email({ smtp_password: "x" }) }), /unknown property email\.smtp_password/);
    await expect400(body({ telegram: telegram({ token: "x" }) }), /unknown property telegram\.token/);
    expect((await pool.query("select 1 from settings")).rowCount).toBe(0);
  });

  it("an omitted smtp_pass / bot_token keeps the stored one", async () => {
    expect((await put(app, curator.token, body())).statusCode).toBe(204);
    const { smtp_pass: _p, ...emailNoPass } = email({ smtp_host: "smtp2.example.com" });
    const { bot_token: _t, ...telegramNoToken } = telegram({ chat_id: "42" });
    expect((await put(app, curator.token, body({ email: emailNoPass, telegram: telegramNoToken }))).statusCode).toBe(204);
    const cfg = await getReviewDigestConfig(pool, KEY);
    expect(cfg).toMatchObject({
      email: { smtp_host: "smtp2.example.com", smtp_pass: SMTP_PASS },
      telegram: { chat_id: "42", bot_token: BOT_TOKEN },
    });
  });

  it("400 when a secret is omitted and none is stored", async () => {
    const { smtp_pass: _p, ...emailNoPass } = email();
    const { bot_token: _t, ...telegramNoToken } = telegram();
    await expect400(body({ email: emailNoPass }), /smtp_pass/);
    await expect400(body({ telegram: telegramNoToken }), /bot_token/);
    expect((await pool.query("select 1 from settings")).rowCount).toBe(0);
  });

  it("omitting a channel turns it off", async () => {
    expect((await put(app, curator.token, body())).statusCode).toBe(204);
    expect((await put(app, curator.token, { enabled: false, dashboard_url: "http://localhost:3000" })).statusCode).toBe(204);
    expect(await getDigest(app, curator.token)).toMatchObject({ enabled: false, channels: { email: null, telegram: null } });
    expect(await getReviewDigestConfig(pool, KEY)).toMatchObject({ email: null, telegram: null });
  });

  it("a member gets 403 on PUT and null on GET", async () => {
    expect((await put(app, alice.token, body())).statusCode).toBe(403);
    expect((await put(app, alice.token, { enabled: "yes" })).statusCode).toBe(403);
    expect((await pool.query("select 1 from settings")).rowCount).toBe(0);
    expect((await put(app, curator.token, body())).statusCode).toBe(204);
    expect(await getDigest(app, alice.token)).toBeNull();
  });

  it("503 without HIVE_SECRET_KEY, and GET shows null", async () => {
    expect((await put(app, curator.token, body())).statusCode).toBe(204);
    const noKey = buildApp(pool, { version: "test" });
    const res = await put(noKey, curator.token, body());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "HIVE_SECRET_KEY is not set" });
    expect(await getDigest(noKey, curator.token)).toBeNull();
    await noKey.close();
  });

  it("GET shows null when the stored config was saved under another key", async () => {
    expect((await put(app, curator.token, body())).statusCode).toBe(204);
    const otherKey = buildApp(pool, { version: "test", secretKey: randomBytes(32) });
    expect(await getDigest(otherKey, curator.token)).toBeNull();
    await otherKey.close();
  });

  it("last_* come from the latest review_digests row", async () => {
    expect((await put(app, curator.token, body())).statusCode).toBe(204);
    await pool.query(
      `insert into review_digests (local_date, claimed_at, sent_at, item_count, email_status, email_error, telegram_status, telegram_error) values
       ('2026-11-08', '2026-11-08T18:00:00Z', '2026-11-08T18:00:05Z', 9, 'sent', null, 'sent', null),
       ('2026-11-09', '2026-11-09T18:00:00Z', '2026-11-09T18:00:05Z', 3, 'failed', 'auth failed', 'failed', 'chat not found')`,
    );
    expect(await getDigest(app, curator.token)).toMatchObject({
      last_sent_at: "2026-11-09T18:00:05.000Z",
      last_item_count: 3,
      last_error: "email: auth failed; telegram: chat not found",
    });
  });

  it("the password and token never appear in GET or the logs", async () => {
    let logs = "";
    const stream = new Writable({ write: (chunk, _enc, cb) => ((logs += chunk.toString()), cb()) });
    const logged = buildApp(pool, { version: "test", secretKey: KEY, logger: { level: "trace", stream } });
    expect((await put(logged, curator.token, body())).statusCode).toBe(204);
    expect((await put(logged, curator.token, body({ time: "25:00" }))).statusCode).toBe(400);
    const res = await logged.inject({ url: "/v1/settings", headers: auth(curator.token) });
    await logged.close();
    expect(logs).toContain("/v1/settings/review-digest"); // the logger did run
    for (const s of [res.body, logs]) {
      expect(s).not.toContain(SMTP_PASS);
      expect(s).not.toContain(BOT_TOKEN);
    }
  });
});
