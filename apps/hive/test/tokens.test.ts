import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createInstance, findInstanceByToken } from "../src/auth.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let curator: string;
let curatorId: string;
let member: string;
let worker: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const status = async (token: string) => (await app.inject({ url: "/v1/status", headers: auth(token) })).statusCode;

beforeAll(async () => {
  pool = await freshDb();
  app = buildApp(pool, { version: "test" });
  const c = await createInstance(pool, { name: "boss", userId: "jon", role: "curator" });
  curator = c.token;
  curatorId = c.instance.id;
  member = (await createInstance(pool, { name: "laptop", userId: "ann" })).token;
  worker = (await createInstance(pool, { name: "fact-agent", userId: "hive", role: "worker" })).token;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function create(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/v1/instances", headers: auth(curator), payload: body });
}
async function act(id: string, action: "revoke" | "rotate", token = curator) {
  return app.inject({ method: "POST", url: `/v1/instances/${id}/${action}`, headers: auth(token) });
}
async function list(query = "") {
  return app.inject({ url: `/v1/instances${query}`, headers: auth(curator) });
}

describe("/v1/instances", () => {
  it("creates a token: 201 with the public row and a token that works", async () => {
    const res = await create({ name: "studio", user_id: "jon", role: "member" });
    expect(res.statusCode).toBe(201);
    const { instance, token } = res.json();
    expect(instance).toMatchObject({ name: "studio", user_id: "jon", role: "member", revoked_at: null, rotated_at: null });
    expect(instance.created_at).toBeTruthy();
    expect(instance).not.toHaveProperty("token_hash");
    expect(token).toMatch(/^hive_/);
    expect(await status(token)).toBe(200);
  });

  it("create: 400 for a bad role or any missing field", async () => {
    expect((await create({ name: "x1", user_id: "u", role: "admin" })).statusCode).toBe(400);
    expect((await create({ user_id: "u", role: "member" })).statusCode).toBe(400);
    expect((await create({ name: "x2", role: "member" })).statusCode).toBe(400);
    expect((await create({ name: "x3", user_id: "u" })).statusCode).toBe(400);
    expect((await create({ name: "", user_id: "u", role: "member" })).statusCode).toBe(400);
    expect((await create({ name: "x4", user_id: "", role: "member" })).statusCode).toBe(400);
  });

  it("create: 409 for a duplicate name, including a revoked instance's name", async () => {
    expect((await create({ name: "laptop", user_id: "ann", role: "member" })).statusCode).toBe(409);
    const gone = (await create({ name: "old-box", user_id: "ann", role: "member" })).json();
    expect((await act(gone.instance.id, "revoke")).statusCode).toBe(200);
    expect((await create({ name: "old-box", user_id: "ann", role: "member" })).statusCode).toBe(409);
  });

  it("lists unrevoked instances by default, revoked too with ?revoked=true, never token_hash", async () => {
    const made = (await create({ name: "listed-revoked", user_id: "u", role: "member" })).json();
    await act(made.instance.id, "revoke");
    const def = await list();
    expect(def.statusCode).toBe(200);
    const names = def.json().instances.map((i: { name: string }) => i.name);
    expect(names.slice(0, 3)).toEqual(["boss", "laptop", "fact-agent"]);
    expect(names).not.toContain("listed-revoked");
    const all = (await list("?revoked=true")).json().instances;
    expect(all.map((i: { name: string }) => i.name)).toContain("listed-revoked");
    for (const i of all) expect(i).not.toHaveProperty("token_hash");
    expect(JSON.stringify(all)).not.toContain("token_hash");
  });

  it("revoke: the token stops working; 404 unknown or non-uuid; 409 twice; 409 on yourself", async () => {
    const { instance, token } = (await create({ name: "to-revoke", user_id: "u", role: "member" })).json();
    const res = await act(instance.id, "revoke");
    expect(res.statusCode).toBe(200);
    expect(res.json().instance.revoked_at).not.toBeNull();
    expect(await status(token)).toBe(401);
    expect((await act(instance.id, "revoke")).statusCode).toBe(409);
    expect((await act("00000000-0000-0000-0000-000000000000", "revoke")).statusCode).toBe(404);
    expect((await act("not-a-uuid", "revoke")).statusCode).toBe(404);
    const self = await act(curatorId, "revoke");
    expect(self.statusCode).toBe(409);
    expect(self.json().error).toMatch(/rotate it instead/);
    expect(await status(curator)).toBe(200);
  });

  it("rotate: old token 401, new 200; earlier episodes keep the instance_id; 404 unknown; 409 revoked", async () => {
    const { instance, token } = (await create({ name: "to-rotate", user_id: "u", role: "member" })).json();
    const ep = await app.inject({
      method: "POST", url: "/v1/episodes", headers: auth(token), payload: { kind: "turn", session_id: "s1", content: "user: hello" },
    });
    expect(ep.statusCode).toBe(201);
    const res = await act(instance.id, "rotate");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.instance).toMatchObject({ id: instance.id, name: "to-rotate" });
    expect(body.instance.rotated_at).not.toBeNull();
    expect(body.instance).not.toHaveProperty("token_hash");
    expect(body.token).not.toBe(token);
    expect(await status(token)).toBe(401);
    expect(await status(body.token)).toBe(200);
    const { rows } = await pool.query("select instance_id from episodes where id = $1", [ep.json().episode.id]);
    expect(rows[0].instance_id).toBe(instance.id);

    expect((await act("00000000-0000-0000-0000-000000000000", "rotate")).statusCode).toBe(404);
    expect((await act("nope", "rotate")).statusCode).toBe(404);
    await act(instance.id, "revoke");
    expect((await act(instance.id, "rotate")).statusCode).toBe(409);
  });

  it("a curator can rotate its own token", async () => {
    const c = (await create({ name: "self-rotator", user_id: "jon", role: "curator" })).json();
    const res = await act(c.instance.id, "rotate", c.token);
    expect(res.statusCode).toBe(200);
    expect(await status(c.token)).toBe(401);
    expect(await status(res.json().token)).toBe(200);
  });

  it("members and workers get 403 on every route", async () => {
    for (const token of [member, worker]) {
      const h = auth(token);
      expect((await app.inject({ url: "/v1/instances", headers: h })).statusCode).toBe(403);
      expect(
        (await app.inject({ method: "POST", url: "/v1/instances", headers: h, payload: { name: "z", user_id: "z", role: "curator" } }))
          .statusCode,
      ).toBe(403);
      expect((await act(curatorId, "revoke", token)).statusCode).toBe(403);
      expect((await act(curatorId, "rotate", token)).statusCode).toBe(403);
    }
  });
});

describe("last_seen_at throttle", () => {
  it("is written at most once a minute", async () => {
    const { instance, token } = await createInstance(pool, { name: "throttled", userId: "u" });
    await pool.query("update instances set last_seen_at = now() - interval '10 seconds' where id = $1", [instance.id]);
    const before = (await pool.query("select last_seen_at from instances where id = $1", [instance.id])).rows[0].last_seen_at;
    await findInstanceByToken(pool, token);
    await findInstanceByToken(pool, token);
    const after = (await pool.query("select last_seen_at from instances where id = $1", [instance.id])).rows[0].last_seen_at;
    expect(after.getTime()).toBe(before.getTime());

    await pool.query("update instances set last_seen_at = now() - interval '61 seconds' where id = $1", [instance.id]);
    const stale = (await pool.query("select last_seen_at from instances where id = $1", [instance.id])).rows[0].last_seen_at;
    expect(await findInstanceByToken(pool, token)).toMatchObject({ id: instance.id });
    const fresh = (await pool.query("select last_seen_at from instances where id = $1", [instance.id])).rows[0].last_seen_at;
    expect(fresh.getTime()).toBeGreaterThan(stale.getTime());
  });
});
