import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { backoffSeconds, deliverDue, sign, startWebhookDispatcher } from "../src/webhooks.js";
import { freshDb } from "./helpers.js";

const KEY = randomBytes(32);
const SECRET = "test-webhook-secret-0123456789";

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  json: { id: string; event: string; occurred_at: string; fact: Record<string, unknown> };
}

let pool: pg.Pool;
let app: FastifyInstance;
let receiver: Server;
let receiverUrl: string;
let received: Received[];
let replyStatus: number;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const call = (token: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(token), payload: payload as object });

async function remember(token: string, body: Record<string, unknown>) {
  const res = await call(token, "POST", "/v1/facts", { kind: "decision", scope: "global", ...body });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().fact as { id: string; status: string };
}
async function createHook(body: Record<string, unknown> = {}) {
  const res = await call(curator.token, "POST", "/v1/webhooks", { url: receiverUrl, secret: SECRET, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().webhook as { id: string };
}
/** Deliver everything due (test backoff is 0, so retries are due at once). */
async function drain(opts: { maxAttempts?: number } = {}) {
  while ((await deliverDue(pool, KEY, { backoffSeconds: 0, ...opts })) > 0);
}
const events = () => received.map((r) => `${r.json.event} ${r.json.fact.status}`);

beforeAll(async () => {
  pool = await freshDb();
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body, json: JSON.parse(body) });
      res.writeHead(replyStatus).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  await new Promise((r) => receiver.close(r));
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate webhooks, webhook_deliveries, llm_calls, reviews, anchors, facts, episodes, instances cascade");
  received = [];
  replyStatus = 200;
  app = buildApp(pool, { version: "test", secretKey: KEY });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
});
afterEach(async () => {
  await app.close();
});

describe("events", () => {
  it("candidate -> approve sends a signed fact.activated", async () => {
    await createHook({ events: ["fact.activated"] });
    const f = await remember(alice.token, { text: "We deploy from main only" });
    await drain();
    expect(received).toHaveLength(0); // a candidate is not activated
    expect((await call(curator.token, "POST", `/v1/facts/${f.id}/review`, { action: "approve" })).statusCode).toBe(200);
    await drain();
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.json).toMatchObject({
      event: "fact.activated",
      occurred_at: expect.any(String),
      fact: { id: f.id, text: "We deploy from main only", kind: "decision", scope: "global", origin: "authored", status: "active", status_note: null, supersedes: null },
    });
    expect(r.headers["x-hive-event"]).toBe("fact.activated");
    expect(r.headers["x-hive-delivery"]).toBe(r.json.id);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["x-hive-signature"]).toBe(sign(SECRET, r.body));
    expect(sign(SECRET, r.body)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sign("other-secret-0123456789", r.body)).not.toBe(r.headers["x-hive-signature"]);
    const d = (await pool.query("select status, attempts, delivered_at from webhook_deliveries")).rows;
    expect(d).toEqual([{ status: "delivered", attempts: 1, delivered_at: expect.any(Date) }]);
  });

  it("all events by default: recorded, activated, retracted, superseded", async () => {
    await createHook();
    const cand = await remember(alice.token, { text: "Billing runs on Fridays" });
    const old = await remember(curator.token, { text: "Logs go to Loki" }); // curator: recorded + activated
    const next = await remember(curator.token, { text: "Logs go to Grafana Cloud", supersedes: old.id });
    expect((await call(curator.token, "POST", `/v1/facts/${cand.id}/retract`, { reason: "wrong" })).statusCode).toBe(200);
    await drain();
    expect(events()).toEqual([
      "fact.recorded candidate",
      "fact.recorded active",
      "fact.activated active",
      "fact.recorded active",
      "fact.activated active",
      "fact.superseded superseded",
      "fact.retracted retracted",
    ]);
    expect(received[4]!.json.fact).toMatchObject({ id: next.id, supersedes: old.id }); // set after the insert, same transaction
    expect(received[5]!.json.fact).toMatchObject({ id: old.id, status: "superseded" });
    expect(received.at(-1)!.json.fact).toMatchObject({ id: cand.id, status_note: "wrong" });
  });

  it("reject and a bulk SQL retract (verify) fire fact.retracted", async () => {
    await createHook({ events: ["fact.retracted"] });
    const a = await remember(alice.token, { text: "Cache TTL is five minutes" });
    const b = await remember(curator.token, { text: "Queue depth alarm at 1000" });
    await call(curator.token, "POST", `/v1/facts/${a.id}/review`, { action: "reject" });
    await pool.query("update facts set status = 'retracted', status_note = 'source gone' where id = $1", [b.id]);
    await pool.query("update facts set text = 'Queue depth alarm at 2000' where id = $1", [b.id]); // not a status change
    await pool.query("update facts set status = status, status_note = 'again' where id = $1", [b.id]); // status unchanged
    await drain();
    expect(events()).toEqual(["fact.retracted retracted", "fact.retracted retracted"]);
  });

  it("personal-scope facts, unsubscribed events and inactive hooks send nothing", async () => {
    await createHook({ events: ["fact.retracted"] });
    await createHook({ events: ["fact.recorded"], active: false });
    const p = await remember(alice.token, { text: "I prefer tabs", scope: "personal" });
    expect((await call(alice.token, "POST", `/v1/facts/${p.id}/retract`, { reason: "changed my mind" })).statusCode).toBe(200);
    await remember(curator.token, { text: "Use pnpm, not npm" }); // recorded + activated: not subscribed
    await drain();
    expect(received).toHaveLength(0);
    expect((await pool.query("select 1 from webhook_deliveries")).rowCount).toBe(0);
  });
});

describe("retries", () => {
  it("retries a 500 up to maxAttempts, flags the hook, and a later 2xx clears it", async () => {
    const hook = await createHook({ events: ["fact.activated"] });
    replyStatus = 500;
    await remember(curator.token, { text: "Deploys freeze on Fridays" });
    await drain({ maxAttempts: 3 });
    expect(received).toHaveLength(3);
    expect(new Set(received.map((r) => r.json.id)).size).toBe(1); // the same delivery each time
    const d = (await pool.query("select status, attempts, last_error from webhook_deliveries")).rows;
    expect(d).toEqual([{ status: "failed", attempts: 3, last_error: "HTTP 500" }]);
    let w = (await call(curator.token, "GET", `/v1/webhooks/${hook.id}`)).json();
    expect(w.webhook).toMatchObject({ failing_since: expect.any(String), last_error: "HTTP 500" });
    expect(w.deliveries).toMatchObject([{ status: "failed", attempts: 3 }]);

    // still receives new events, and one success clears the flag
    replyStatus = 204;
    await remember(curator.token, { text: "Deploys freeze on Mondays" });
    await drain({ maxAttempts: 3 });
    w = (await call(curator.token, "GET", `/v1/webhooks/${hook.id}`)).json();
    expect(w.webhook).toMatchObject({ failing_since: null, last_error: null });
  });

  it("waits base * 2^(n-1) between attempts, capped at an hour", async () => {
    expect([1, 2, 3, 4].map((n) => backoffSeconds(30, n))).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(30, 20)).toBe(3600);
    await createHook({ events: ["fact.activated"], url: "http://127.0.0.1:1/unreachable" });
    await remember(curator.token, { text: "Nothing listens on port 1" });
    expect(await deliverDue(pool, KEY, { backoffSeconds: 30 })).toBe(1);
    expect(await deliverDue(pool, KEY, { backoffSeconds: 30 })).toBe(0); // not due yet
    const { rows } = await pool.query("select status, attempts, last_error, extract(epoch from next_attempt_at - now()) as wait from webhook_deliveries");
    expect(rows[0]).toMatchObject({ status: "queued", attempts: 1, last_error: expect.stringContaining("fetch failed") });
    expect(Number(rows[0].wait)).toBeGreaterThan(25);
    expect(Number(rows[0].wait)).toBeLessThanOrEqual(30);
  });

  it("the dispatcher delivers in the background and stops", async () => {
    await createHook({ events: ["fact.activated"] });
    const d = startWebhookDispatcher(pool, KEY, { intervalMs: 20 });
    await remember(curator.token, { text: "The dispatcher polls" });
    await expect.poll(() => received.length, { timeout: 3000 }).toBe(1);
    await d.stop();
  });
});

describe("CRUD", () => {
  it("create returns the secret once (generated when omitted); GET never shows it", async () => {
    const res = await call(curator.token, "POST", "/v1/webhooks", { url: "https://example.com/hook" });
    expect(res.statusCode, res.body).toBe(201);
    const { webhook, secret } = res.json();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(webhook).toEqual({
      id: expect.any(String), url: "https://example.com/hook", active: true, created_at: expect.any(String),
      events: ["fact.recorded", "fact.activated", "fact.retracted", "fact.superseded"],
      created_by_user_id: "jon", failing_since: null, last_error: null,
    });
    const list = await call(curator.token, "GET", "/v1/webhooks");
    expect(list.json()).toEqual({ webhooks: [webhook] });
    const one = await call(curator.token, "GET", `/v1/webhooks/${webhook.id}`);
    expect(one.json()).toEqual({ webhook, deliveries: [] });
    for (const body of [list.body, one.body]) {
      expect(body).not.toContain(secret);
      expect(body).not.toContain("secret");
    }
    const stored = (await pool.query("select secret_enc from webhooks")).rows[0].secret_enc as Buffer;
    expect(stored.includes(Buffer.from(secret))).toBe(false);
  });

  it("PATCH changes url/events/active/secret; DELETE removes it", async () => {
    const hook = await createHook();
    const res = await call(curator.token, "PATCH", `/v1/webhooks/${hook.id}`, { events: ["fact.retracted"], active: false, secret: "a-brand-new-secret-value" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().webhook).toMatchObject({ url: receiverUrl, events: ["fact.retracted"], active: false });
    expect(res.body).not.toContain("a-brand-new-secret-value");
    await call(curator.token, "PATCH", `/v1/webhooks/${hook.id}`, { active: true });
    const f = await remember(curator.token, { text: "Rotate secrets yearly" });
    expect((await call(curator.token, "POST", `/v1/facts/${f.id}/retract`, { reason: "outdated" })).statusCode).toBe(200);
    await drain();
    expect(received).toHaveLength(1);
    expect(received[0]!.headers["x-hive-signature"]).toBe(sign("a-brand-new-secret-value", received[0]!.body));

    expect((await call(curator.token, "DELETE", `/v1/webhooks/${hook.id}`)).statusCode).toBe(204);
    expect((await call(curator.token, "GET", `/v1/webhooks/${hook.id}`)).statusCode).toBe(404);
    expect((await call(curator.token, "DELETE", `/v1/webhooks/${hook.id}`)).statusCode).toBe(404);
    expect((await pool.query("select 1 from webhook_deliveries")).rowCount).toBe(0);
  });

  it("rejects non-http urls, unknown events and a short secret", async () => {
    const bad = [
      { url: "ftp://example.com/x" },
      { url: "not a url" },
      { url: "https://example.com", events: ["fact.deleted"] },
      { url: "https://example.com", events: [] },
      { url: "https://example.com", secret: "short" },
    ];
    for (const b of bad) expect((await call(curator.token, "POST", "/v1/webhooks", b)).statusCode).toBe(400);
    const hook = await createHook();
    expect((await call(curator.token, "PATCH", `/v1/webhooks/${hook.id}`, { url: "file:///etc/passwd" })).statusCode).toBe(400);
    expect((await call(curator.token, "PATCH", `/v1/webhooks/${hook.id}`, {})).statusCode).toBe(400);
  });

  it("a member gets 403; no key is 503", async () => {
    const hook = await createHook();
    const forbidden = [
      await call(alice.token, "POST", "/v1/webhooks", { url: "https://example.com" }),
      await call(alice.token, "GET", "/v1/webhooks"),
      await call(alice.token, "GET", `/v1/webhooks/${hook.id}`),
      await call(alice.token, "PATCH", `/v1/webhooks/${hook.id}`, { active: false }),
      await call(alice.token, "DELETE", `/v1/webhooks/${hook.id}`),
    ];
    for (const res of forbidden) expect(res.statusCode).toBe(403);
    const noKey = buildApp(pool, { version: "test" });
    const res = await noKey.inject({ method: "POST", url: "/v1/webhooks", headers: auth(curator.token), payload: { url: "https://example.com" } });
    expect(res.statusCode).toBe(503);
    expect((await noKey.inject({ url: "/v1/webhooks", headers: auth(curator.token) })).statusCode).toBe(503);
    await noKey.close();
  });

  it("config: max attempts and backoff", () => {
    const base = { DATABASE_URL: "postgres://x" };
    expect(loadConfig(base)).toMatchObject({ webhookMaxAttempts: 6, webhookBackoffSeconds: 30 });
    expect(loadConfig({ ...base, HIVE_WEBHOOK_MAX_ATTEMPTS: "3", HIVE_WEBHOOK_BACKOFF_SECONDS: "5" })).toMatchObject({ webhookMaxAttempts: 3, webhookBackoffSeconds: 5 });
    expect(() => loadConfig({ ...base, HIVE_WEBHOOK_MAX_ATTEMPTS: "0" })).toThrow(/HIVE_WEBHOOK_MAX_ATTEMPTS/);
  });
});
