import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { getAgentCredential } from "../src/routes/settings.js";
import { decryptSecret, encryptSecret } from "../src/secrets.js";
import { freshDb } from "./helpers.js";

const KEY = randomBytes(32);
const CREDENTIAL = "sk-ant-oat01-SUPERSECRET-credential-value";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let worker: { instance: Instance; token: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const putCredential = (a: FastifyInstance, token: string, credential: unknown = CREDENTIAL) =>
  a.inject({ method: "PUT", url: "/v1/settings/agent-credential", headers: auth(token), payload: { credential } });
const getSettings = (a: FastifyInstance, token: string) => a.inject({ url: "/v1/settings", headers: auth(token) });

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate settings, llm_calls, reviews, anchors, facts, episodes, doc_chunks, instances cascade");
  app = buildApp(pool, { version: "test", secretKey: KEY });
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  worker = await createInstance(pool, { name: "hive-worker", userId: "hive", role: "worker" });
});
afterEach(async () => {
  await app.close();
});

describe("agent credential", () => {
  it("is not set at first", async () => {
    const res = await getSettings(app, alice.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ agent_credential: { present: false, set_at: null }, review_digest: null });
  });

  it("a curator sets it; GET shows present/set_at and never the value", async () => {
    const put = await putCredential(app, curator.token);
    expect(put.statusCode, put.body).toBe(204);
    for (const t of [curator.token, alice.token]) {
      const res = await getSettings(app, t);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ agent_credential: { present: true, set_at: expect.any(String) }, review_digest: null });
      expect(res.body).not.toContain(CREDENTIAL);
    }
    const row = (await pool.query("select set_by_user_id from settings")).rows;
    expect(row).toEqual([{ set_by_user_id: "jon" }]);
  });

  it("is stored encrypted, decrypts back, and a re-PUT replaces it", async () => {
    expect((await putCredential(app, curator.token, "first")).statusCode).toBe(204);
    expect((await putCredential(app, curator.token)).statusCode).toBe(204);
    const { rows } = await pool.query<{ value_enc: Buffer }>("select value_enc from settings");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value_enc.includes(Buffer.from(CREDENTIAL))).toBe(false);
    expect(decryptSecret(rows[0]!.value_enc, KEY)).toBe(CREDENTIAL);
    expect(await getAgentCredential(pool, KEY)).toBe(CREDENTIAL);
  });

  it("a wrong key or tampered data fails to decrypt", async () => {
    await putCredential(app, curator.token);
    await expect(getAgentCredential(pool, randomBytes(32))).rejects.toThrow();
    const blob = encryptSecret(CREDENTIAL, KEY);
    blob[blob.length - 1]! ^= 1;
    expect(() => decryptSecret(blob, KEY)).toThrow();
  });

  it("a truncated blob fails to decrypt", () => {
    expect(() => decryptSecret(Buffer.alloc(10), KEY)).toThrow(/truncated/);
  });

  it("a member cannot set it", async () => {
    expect((await putCredential(app, alice.token)).statusCode).toBe(403);
    expect((await pool.query("select 1 from settings")).rowCount).toBe(0);
  });

  it("rejects an empty or oversized credential", async () => {
    expect((await putCredential(app, curator.token, "")).statusCode).toBe(400);
    expect((await putCredential(app, curator.token, "x".repeat(4097))).statusCode).toBe(400);
  });

  it("503 when HIVE_SECRET_KEY is not set", async () => {
    const noKey = buildApp(pool, { version: "test" });
    const res = await putCredential(noKey, curator.token);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "HIVE_SECRET_KEY is not set" });
    await noKey.close();
  });

  it("never appears in the logs", async () => {
    let logs = "";
    const stream = new Writable({ write: (chunk, _enc, cb) => ((logs += chunk.toString()), cb()) });
    const logged = buildApp(pool, { version: "test", secretKey: KEY, logger: { level: "trace", stream } });
    expect((await putCredential(logged, curator.token)).statusCode).toBe(204);
    expect((await getSettings(logged, curator.token)).statusCode).toBe(200);
    await logged.close();
    expect(logs).toContain("/v1/settings/agent-credential"); // the logger did run
    expect(logs).not.toContain(CREDENTIAL);
    expect(logs).not.toContain(curator.token);
  });
});

describe("worker tokens", () => {
  it("can reach /v1/status", async () => {
    const res = await app.inject({ url: "/v1/status", headers: auth(worker.token) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().instance.role).toBe("worker");
  });

  it("are confined to /v1/worker/*", async () => {
    const forbidden = [
      await putCredential(app, worker.token),
      await getSettings(app, worker.token),
      await app.inject({ url: "/v1/facts", headers: auth(worker.token) }),
      await app.inject({ url: "/v1/facts?status=/v1/worker/x", headers: auth(worker.token) }),
      await app.inject({ method: "POST", url: "/v1/facts", headers: auth(worker.token), payload: { text: "x", kind: "decision", scope: "global" } }),
    ];
    for (const res of forbidden) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "worker tokens can only use /v1/worker/*" });
    }
    expect((await pool.query("select 1 from settings union all select 1 from facts")).rowCount).toBe(0);
    // Not confined: a /v1/worker/* path gets through to routing (no such route yet in part 1).
    expect((await app.inject({ url: "/v1/worker/anything", headers: auth(worker.token) })).statusCode).toBe(404);
  });
});

describe("config and CLI", () => {
  const base = { DATABASE_URL: "postgres://x" };
  const hex = KEY.toString("hex");

  it("reads HIVE_SECRET_KEY, else HIVE_SECRET_KEY_FILE; unset is null", () => {
    expect(loadConfig(base).secretKey).toBeNull();
    expect(loadConfig({ ...base, HIVE_SECRET_KEY: hex }).secretKey).toEqual(KEY);
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hive-key-")), "key");
    writeFileSync(file, `${hex}\n`);
    expect(loadConfig({ ...base, HIVE_SECRET_KEY_FILE: file }).secretKey).toEqual(KEY);
  });

  it("HIVE_SECRET_KEY takes precedence over HIVE_SECRET_KEY_FILE", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "hive-key-")), "key");
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`);
    expect(loadConfig({ ...base, HIVE_SECRET_KEY: hex, HIVE_SECRET_KEY_FILE: file }).secretKey).toEqual(KEY);
  });

  it("a malformed or unreadable key fails", () => {
    expect(() => loadConfig({ ...base, HIVE_SECRET_KEY: "abc" })).toThrow(/64 hex/);
    expect(() => loadConfig({ ...base, HIVE_SECRET_KEY: "z".repeat(64) })).toThrow(/64 hex/);
    expect(() => loadConfig({ ...base, HIVE_SECRET_KEY_FILE: "/nonexistent/hive-key" })).toThrow(/HIVE_SECRET_KEY_FILE/);
  });

  it("mint-token rejects an unknown role (before touching the database)", () => {
    const out = spawnSync("npx", ["tsx", "src/cli/mint-token.ts", "--name", "x", "--user", "y", "--role", "admin"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { ...process.env, DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" },
      encoding: "utf8",
    });
    expect(out.status, out.stderr).toBe(2);
    expect(out.stderr).toContain("--role must be one of member, curator, worker");
  });
});
