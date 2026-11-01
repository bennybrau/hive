import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { buildApp } from "../src/app.js";
import { freshDb } from "./helpers.js";

const INDEX = "<!doctype html><title>hive</title><div id=root></div>";
let pool: pg.Pool;
let dir: string;

beforeAll(async () => {
  pool = await freshDb();
  dir = mkdtempSync(join(tmpdir(), "hive-dashboard-"));
  writeFileSync(join(dir, "index.html"), INDEX);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('asset')");
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await pool.end();
});

describe("dashboard", () => {
  it("serves index.html at / and for client routes like /facts/x", async () => {
    const app = buildApp(pool, { version: "test", dashboardDir: dir });
    for (const url of ["/", "/facts/x"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body).toBe(INDEX);
    }
  });

  it("serves a real built asset as itself, not the index.html fallback", async () => {
    const app = buildApp(pool, { version: "test", dashboardDir: dir });
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.body).toBe("console.log('asset')");
  });

  it("keeps JSON 404s for unknown /v1 routes and non-GET requests", async () => {
    const app = buildApp(pool, { version: "test", dashboardDir: dir });
    for (const [method, url] of [["GET", "/v1/nope"], ["GET", "/v1"], ["GET", "/health/x"], ["POST", "/facts/x"]] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
    }
  });

  it("leaves /health unchanged", async () => {
    const app = buildApp(pool, { version: "test", dashboardDir: dir });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: "up", version: "test" });
  });

  it("serves no static files when the directory is missing", async () => {
    for (const dashboardDir of [undefined, join(dir, "missing")]) {
      const app = buildApp(pool, { version: "test", dashboardDir });
      for (const url of ["/", "/facts/x", "/index.html"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
      }
    }
  });
});
