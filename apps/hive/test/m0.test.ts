import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { createInstance, hashToken } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});

describe("migrations", () => {
  it("creates every MVP table and the vector extension", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "anchors", "distill_jobs", "doc_chunks", "doc_files", "episodes", "facts", "instances", "llm_calls", "repos", "reviews", "schema_migrations", "settings", "webhook_deliveries", "webhooks",
    ]);
    const ext = await pool.query("select 1 from pg_extension where extname = 'vector'");
    expect(ext.rowCount).toBe(1);
  });

  it("pool connections run with pgvector iterative scan (filtered vector queries don't come back short)", async () => {
    const { rows } = await pool.query("show hnsw.iterative_scan");
    expect(rows[0]["hnsw.iterative_scan"]).toBe("relaxed_order");
  });

  it("is idempotent", async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it("enforces the fact scope format", async () => {
    await expect(
      pool.query(
        `insert into facts (text, kind, scope, origin, status, content_hash) values ('x', 'decision', 'team', 'authored', 'candidate', 'h1')`,
      ),
    ).rejects.toThrow(/facts_scope_check/);
  });
});

describe("auth + routes", () => {
  it("GET /health is public and reports the db", async () => {
    const app = buildApp(pool, { version: "test" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: "up", version: "test" });
  });

  it("stores only the token hash", async () => {
    const { instance, token } = await createInstance(pool, { name: "hash-check", userId: "u1" });
    const { rows } = await pool.query("select token_hash from instances where id = $1", [instance.id]);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(rows[0].token_hash).not.toContain(token);
  });

  it("/v1/status: 401 without a token, 401 with a bogus one, 200 for two different instances", async () => {
    const app = buildApp(pool, { version: "test" });
    const a = await createInstance(pool, { name: "jon-macbook", userId: "jon", role: "curator" });
    const b = await createInstance(pool, { name: "jon-studio", userId: "jon" });

    expect((await app.inject({ url: "/v1/status" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/status", headers: { authorization: "Bearer hive_nope" } })).statusCode).toBe(401);

    for (const [who, role] of [[a, "curator"], [b, "member"]] as const) {
      const res = await app.inject({ url: "/v1/status", headers: { authorization: `Bearer ${who.token}` } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.instance).toMatchObject({ name: who.instance.name, user_id: "jon", role });
      expect(body.counts).toMatchObject({ facts: 0, episodes: 0, repos: 0 });
    }
    const seen = await pool.query("select last_seen_at from instances where id = $1", [a.instance.id]);
    expect(seen.rows[0].last_seen_at).not.toBeNull();
  });

  it("revoked tokens stop working", async () => {
    const app = buildApp(pool, { version: "test" });
    const { instance, token } = await createInstance(pool, { name: "to-revoke", userId: "u2" });
    await pool.query("update instances set revoked_at = now() where id = $1", [instance.id]);
    const res = await app.inject({ url: "/v1/status", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
});
