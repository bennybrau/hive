import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { simpleParser, type ParsedMail } from "mailparser";
import type pg from "pg";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { sendDigestChannels } from "../src/review-digest/channels.js";
import { saveReviewDigestConfig, type ReviewDigestConfig } from "../src/review-digest/config.js";
import type { Digest } from "../src/review-digest/content.js";
import { freshDb } from "./helpers.js";

const KEY = randomBytes(32);
const SMTP_USER = "hive";
const SMTP_PASS = "smtp-SUPER/SECRET password";
const BOT_TOKEN = "123456:BOT-SUPERSECRET-token";

/** A fake Telegram Bot API: records each request and answers from `replies` (then 200 ok). */
let telegram: Server;
let telegramUrl: string;
let telegramReqs: { path: string; body: Record<string, unknown> }[];
let telegramReplies: { status: number; body: unknown }[];

/** A fake SMTP server: accepts SMTP_USER / SMTP_PASS (unless `refuse`) and parses each message. */
let smtp: SMTPServer;
let smtpPort: number;
let mails: ParsedMail[];
let refuse: boolean;
let slowMs: number;

beforeAll(async () => {
  telegram = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      telegramReqs.push({ path: req.url ?? "", body: JSON.parse(raw) });
      const reply = telegramReplies.shift() ?? { status: 200, body: { ok: true, result: {} } };
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => telegram.listen(0, "127.0.0.1", r));
  telegramUrl = `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`;

  smtp = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, cb) {
      const respond = () => {
        // The refusal echoes the password, as a careless server might: it must not reach the caller.
        if (refuse) return cb(new Error(`no thanks, ${auth.username}:${auth.password}`));
        if (auth.username === SMTP_USER && auth.password === SMTP_PASS) return cb(null, { user: auth.username });
        cb(new Error("bad login"));
      };
      if (slowMs) setTimeout(respond, slowMs);
      else respond();
    },
    onData(stream, _session, cb) {
      simpleParser(stream).then((m) => (mails.push(m), cb()), cb);
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => telegram.close(r));
  await new Promise((r) => smtp.close(() => r(undefined)));
});
beforeEach(() => {
  telegramReqs = [];
  telegramReplies = [];
  mails = [];
  refuse = false;
  slowMs = 0;
});

const channels = (): Pick<ReviewDigestConfig, "email" | "telegram"> => ({
  email: {
    smtp_host: "127.0.0.1",
    smtp_port: smtpPort,
    smtp_secure: false,
    smtp_user: SMTP_USER,
    smtp_pass: SMTP_PASS,
    from: "hive@example.com",
    to: ["jon@example.com", "ann@example.com"],
  },
  telegram: { bot_token: BOT_TOKEN, chat_id: "-100123" },
});
const DIGEST: Digest = {
  total: 1,
  newCount: 1,
  items: [{ ref: "[hive:abcdef01]", text: "Deploys go out on <Thursdays>.", applies: "api", source: "from a chat", waiting: "today", isNew: true }],
  more: 0,
  dashboard_url: "https://hive.example.com",
};
const send = (cfg = channels(), opts: { attempts?: number } = {}) =>
  sendDigestChannels(cfg, DIGEST, { backoffMs: 5, telegramApiUrl: telegramUrl, ...opts });

describe("sendDigestChannels", () => {
  it("posts the Telegram message as HTML without link previews", async () => {
    expect(await send({ ...channels(), email: null })).toEqual({ telegram: { status: "sent", error: null } });
    expect(telegramReqs).toHaveLength(1);
    const { path, body } = telegramReqs[0]!;
    expect(path).toBe(`/bot${BOT_TOKEN}/sendMessage`);
    expect(body).toMatchObject({ chat_id: "-100123", parse_mode: "HTML", disable_web_page_preview: true });
    expect(body.text).toContain("Deploys go out on &lt;Thursdays&gt;. [hive:abcdef01]");
    expect(body.text).toContain('<a href="https://hive.example.com/review">');
  });

  it("retries a Telegram 500 and then succeeds", async () => {
    telegramReplies = [{ status: 500, body: { ok: false, description: "Internal Server Error" } }];
    expect(await send({ ...channels(), email: null })).toEqual({ telegram: { status: "sent", error: null } });
    expect(telegramReqs).toHaveLength(2);
  });

  it("fails with Telegram's description, without the token", async () => {
    const bad = { status: 400, body: { ok: false, description: `Bad Request: chat not found for bot${BOT_TOKEN}` } };
    telegramReplies = [bad, bad, bad];
    const res = await send({ ...channels(), email: null });
    expect(res).toEqual({ telegram: { status: "failed", error: "Bad Request: chat not found for bot***" } });
    expect(telegramReqs).toHaveLength(3);
  });

  it("treats ok:false on a 200 as a failure", async () => {
    telegramReplies = [{ status: 200, body: { ok: false, description: "nope" } }];
    expect(await send({ ...channels(), email: null }, { attempts: 1 })).toEqual({ telegram: { status: "failed", error: "nope" } });
  });

  it("emails a multipart text + HTML message", async () => {
    expect(await send({ ...channels(), telegram: null })).toEqual({ email: { status: "sent", error: null } });
    expect(mails).toHaveLength(1);
    const m = mails[0]!;
    expect(m.subject).toBe("Hive: 1 fact to review (1 new)");
    expect(m.from?.text).toBe("hive@example.com");
    expect((Array.isArray(m.to) ? m.to : [m.to]).flatMap((t) => t!.value.map((a) => a.address))).toEqual(["jon@example.com", "ann@example.com"]);
    expect(m.text).toContain("[new] Deploys go out on <Thursdays>. [hive:abcdef01]");
    expect(m.html).toContain("Deploys go out on &lt;Thursdays&gt;.");
  });

  it("sends Telegram even when the SMTP server refuses, and hides the password", async () => {
    refuse = true;
    const res = await send();
    expect(res.telegram).toEqual({ status: "sent", error: null });
    expect(res.email?.status).toBe("failed");
    expect(res.email?.error).toContain("no thanks");
    expect(res.email?.error).not.toContain(SMTP_PASS);
    expect(res.email?.error).not.toContain(encodeURIComponent(SMTP_PASS));
    expect(mails).toHaveLength(0);
  });

  it("has a key only for configured channels", async () => {
    expect(await send({ email: null, telegram: null })).toEqual({});
  });

  it("sends both channels at once, not one after another", async () => {
    slowMs = 200;
    refuse = true;
    telegramReplies = [{ status: 500, body: { ok: false, description: "slow failure" } }];
    const start = Date.now();
    const res = await send(channels(), { attempts: 1 });
    expect(Date.now() - start).toBeLessThan(350);
    expect(res.telegram?.status).toBe("failed");
    expect(res.email?.status).toBe("failed");
  });
});

describe("POST /v1/review-digest/test", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let logs: string;
  let curator: { instance: Instance; token: string };
  let alice: { instance: Instance; token: string };
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const post = (token: string, a = app) => a.inject({ method: "POST", url: "/v1/review-digest/test", headers: auth(token) });
  const save = (cfg: Partial<ReviewDigestConfig> = {}) =>
    saveReviewDigestConfig(
      pool,
      KEY,
      { enabled: true, time: "18:00", timezone: "Europe/Berlin", dashboard_url: "https://hive.example.com/", ...channels(), ...cfg },
      "jon",
    );

  beforeAll(async () => {
    pool = await freshDb();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("truncate settings, review_digests, facts, instances cascade");
    logs = "";
    const stream = new Writable({ write: (chunk, _enc, cb) => ((logs += chunk.toString()), cb()) });
    app = buildApp(pool, {
      version: "test",
      secretKey: KEY,
      logger: { level: "trace", stream },
      reviewDigest: { telegramApiUrl: telegramUrl, backoffMs: 5 },
    });
    curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
    alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  });
  afterEach(async () => {
    await app.close();
  });

  it("sends an empty queue as Nothing to review, recording nothing", async () => {
    await save();
    const res = await post(curator.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ email: { status: "sent", error: null }, telegram: { status: "sent", error: null } });
    expect(telegramReqs[0]!.body.text).toContain("Hive: Nothing to review");
    expect(mails[0]!.subject).toBe("Hive: Nothing to review");
    expect((await pool.query("select 1 from review_digests")).rowCount).toBe(0);
  });

  it("answers 403 to a member", async () => {
    await save();
    expect((await post(alice.token)).statusCode).toBe(403);
    expect(telegramReqs).toHaveLength(0);
  });

  it("answers 503 without a key", async () => {
    const keyless = buildApp(pool, { version: "test" });
    expect((await post(curator.token, keyless)).statusCode).toBe(503);
    await keyless.close();
  });

  it("answers 409 when not configured, saved under another key, or without a channel", async () => {
    expect((await post(curator.token)).statusCode).toBe(409);
    await saveReviewDigestConfig(pool, randomBytes(32), { enabled: true, time: "18:00", timezone: "UTC", dashboard_url: "https://x.example", ...channels() }, "jon");
    expect((await post(curator.token)).statusCode).toBe(409);
    await save({ email: null, telegram: null });
    const res = await post(curator.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/channel/);
  });

  it("reports each channel's failure and never logs the token or password", async () => {
    await save();
    refuse = true;
    const bad = { status: 400, body: { ok: false, description: `Unauthorized ${BOT_TOKEN}` } };
    telegramReplies = [bad, bad, bad];
    const res = await post(curator.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ email: { status: "failed" }, telegram: { status: "failed", error: "Unauthorized ***" } });
    expect(res.body).not.toContain(BOT_TOKEN);
    expect(res.body).not.toContain(SMTP_PASS);
    expect(logs).toContain("test review digest failed");
    for (const secret of [BOT_TOKEN, SMTP_PASS, encodeURIComponent(BOT_TOKEN), encodeURIComponent(SMTP_PASS)]) {
      expect(logs).not.toContain(secret);
    }
  });
});
