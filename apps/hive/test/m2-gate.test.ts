import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance } from "../src/auth.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";

let pool: pg.Pool;
let app: FastifyInstance;
let token: string;
let embedder: FakeEmbedder;

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await app?.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, instances cascade");
  embedder = new FakeEmbedder();
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5 });
  token = (await createInstance(pool, { name: "jon", userId: "jon", role: "curator" })).token;
  for (const text of ["Use vitest, never jest.", "Services are deployed to Cloud Run by the factory."]) {
    await app.inject({ method: "POST", url: "/v1/facts", headers: { authorization: `Bearer ${token}` }, payload: { text, kind: "convention", scope: "global" } });
  }
});

const recall = async (qs: string) =>
  (await app.inject({ url: `/v1/recall?${qs}`, headers: { authorization: `Bearer ${token}` } })).json() as {
    mode: string;
    facts: { text: string; matched: string[]; similarity: number | null }[];
  };

describe("recall min_sim (prefetch gate)", () => {
  it("drops a keyword-only hit the model judges unrelated; keeps the relevant one", async () => {
    await runEmbedPass(pool, embedder);
    const loose = await recall("q=never%20deploy%20on%20fridays");
    expect(loose.facts.map((f) => f.text)).toContain("Use vitest, never jest."); // matched only on "never"
    const vitest = loose.facts.find((f) => f.text.startsWith("Use vitest"))!;
    expect(vitest.matched).toEqual(["keyword"]);
    expect(vitest.similarity).toBeLessThan(0.2); // keyword hits now carry their similarity

    const strict = await recall("q=never%20deploy%20on%20fridays&min_sim=0.5");
    expect(strict.facts.map((f) => f.text)).toEqual(["Services are deployed to Cloud Run by the factory."]);
  });

  it("keeps un-embedded keyword hits (can't be judged) and works keyword-only", async () => {
    const strict = await recall("q=never%20deploy%20on%20fridays&min_sim=0.9");
    expect(strict.facts.map((f) => f.text)).toContain("Use vitest, never jest.");
    expect(strict.facts.every((f) => f.similarity === null)).toBe(true);
  });

  it("rejects an out-of-range min_sim", async () => {
    const res = await app.inject({ url: "/v1/recall?q=x&min_sim=2", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(400);
  });
});
