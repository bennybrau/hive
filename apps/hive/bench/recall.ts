/**
 * Recall latency benchmark on a realistic-size corpus (docs/MVP-PLAN.md M1: p95 < 200 ms on 10k facts).
 *
 *   BENCH_DATABASE_URL=postgres://hive:<pw>@127.0.0.1:5544/hive_bench OLLAMA_URL=http://127.0.0.1:11434 \
 *     pnpm --filter hive exec tsx bench/recall.ts [--facts 10000] [--requests 500] [--concurrency 4]
 *
 * Uses a separate database (created if missing) so the real hive is untouched. Facts are embedded
 * with the real Ollama model once and reused on later runs. Measures full HTTP round trips through
 * the real Fastify app, including the per-request query embedding.
 */
import { parseArgs } from "node:util";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { createInstance } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { OllamaEmbedder } from "../src/embed.js";
import { contentHash } from "../src/facts.js";
import { runEmbedPass } from "../src/jobs/embed.js";

const { values } = parseArgs({
  options: {
    facts: { type: "string", default: "10000" },
    requests: { type: "string", default: "500" },
    concurrency: { type: "string", default: "4" },
  },
});
const N_FACTS = Number(values.facts);
const N_REQ = Number(values.requests);
const CONC = Number(values.concurrency);
const url = process.env.BENCH_DATABASE_URL;
if (!url) throw new Error("set BENCH_DATABASE_URL (a throwaway database, e.g. .../hive_bench)");

// --- database --------------------------------------------------------------
const dbName = new URL(url).pathname.slice(1);
const admin = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, "/postgres") });
await admin.connect();
if ((await admin.query("select 1 from pg_database where datname = $1", [dbName])).rowCount === 0) {
  await admin.query(`create database "${dbName}"`);
}
await admin.end();
const pool = createPool(url, 20);
await migrate(pool);

// --- corpus ----------------------------------------------------------------
const services = ["billing", "invoice", "auth", "search", "upload", "notifications", "ledger", "gateway", "scheduler", "reporting", "export", "webhooks", "identity", "catalog", "pricing", "checkout", "inventory", "audit", "metrics", "feature-flags"];
const teams = ["Payments", "Platform", "Growth", "Data", "Security", "Mobile", "Core", "Infra", "Search", "Risk"];
const templates = [
  (s: string, t: string, i: number) => `The ${t} team owns the ${s} service (#${i}).`,
  (s: string, _t: string, i: number) => `The ${s} worker retries ${(i % 5) + 1} times before dead-lettering (#${i}).`,
  (s: string, _t: string, i: number) => `${s} deploys to Cloud Run region us-central${(i % 3) + 1}; rollbacks use the previous revision (#${i}).`,
  (s: string, t: string, i: number) => `We chose Postgres over DynamoDB for ${s} because ${t} needs joins for reporting (#${i}).`,
  (s: string, _t: string, i: number) => `Never call ${s} synchronously from the request path; enqueue a job instead (#${i}).`,
  (s: string, _t: string, i: number) => `${s} integration tests live under tests/${s}/ and need the fake clock (#${i}).`,
  (s: string, t: string, i: number) => `Rate limits for ${s} are set by ${t} in the gateway config, not in code (#${i}).`,
  (s: string, _t: string, i: number) => `The ${s} API returns 409 on duplicate idempotency keys; clients must treat it as success (#${i}).`,
];
const have = Number((await pool.query("select count(*) from facts")).rows[0].count);
if (have < N_FACTS) {
  console.log(`seeding ${N_FACTS - have} facts...`);
  const { instance } = await createInstance(pool, { name: `bench-${Date.now()}`, userId: "bench", role: "curator" });
  const rows: unknown[][] = [];
  for (let i = have; i < N_FACTS; i++) {
    const s = services[i % services.length]!;
    const t = teams[(i * 7) % teams.length]!;
    const text = templates[i % templates.length]!(s, t, i);
    const scope = i % 4 === 0 ? "global" : `repo:gh/acme/${services[(i * 3) % services.length]}`;
    rows.push([text, ["decision", "gotcha", "system", "convention"][i % 4], scope, "authored", "active", "bench", instance.id, contentHash(text, scope)]);
  }
  for (let off = 0; off < rows.length; off += 1000) {
    const chunk = rows.slice(off, off + 1000);
    const params: unknown[] = [];
    const values = chunk.map((r, j) => {
      params.push(...r);
      const b = j * 8;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
    });
    await pool.query(
      `insert into facts (text, kind, scope, origin, status, author_user_id, author_instance_id, content_hash) values ${values.join(",")} on conflict do nothing`,
      params,
    );
  }
}
const embedder = new OllamaEmbedder(process.env.OLLAMA_URL ?? "http://127.0.0.1:11434", "nomic-embed-text");
let backlog = Number((await pool.query("select count(*) from facts where embedding is null")).rows[0].count);
if (backlog) {
  console.log(`embedding ${backlog} facts with the real model...`);
  const t0 = Date.now();
  while ((await runEmbedPass(pool, embedder, 128)) > 0) {
    backlog = Number((await pool.query("select count(*) from facts where embedding is null")).rows[0].count);
    process.stdout.write(`\r  ${backlog} left   `);
  }
  console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
await pool.query("analyze facts");

// --- run -------------------------------------------------------------------
const { token } = await createInstance(pool, { name: `bench-reader-${Date.now()}`, userId: "reader" });
const app = buildApp(pool, { version: "bench", embedder, minSimilarity: 0.55 });
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const queries = [
  "who owns the billing service", "how many times does the ledger worker retry", "where does checkout deploy",
  "why did we pick postgres for reporting", "can I call notifications from a request handler", "where are the auth integration tests",
  "who sets rate limits for search", "what does a 409 from the invoice api mean", "rollback procedure for gateway",
  "duplicate idempotency key handling", "which team runs pricing", "dead letter queue behaviour",
];
const latencies: number[] = [];
const modes = new Map<string, number>();
let hits = 0;
let next = 0;
// warm up (model load, connection pool, plan cache)
for (const q of queries) await fetch(`${address}/v1/recall?q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${token}` } });
async function worker() {
  while (next < N_REQ) {
    const i = next++;
    const q = queries[i % queries.length]!;
    const repo = i % 2 ? `&repo_key=gh/acme/${services[i % services.length]}` : "";
    const t0 = performance.now();
    const res = await fetch(`${address}/v1/recall?q=${encodeURIComponent(q)}${repo}`, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { mode: string; facts: unknown[] };
    latencies.push(performance.now() - t0);
    modes.set(body.mode, (modes.get(body.mode) ?? 0) + 1);
    if (body.facts.length) hits++;
  }
}
const wall0 = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
const wall = (performance.now() - wall0) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!.toFixed(1);
const total = Number((await pool.query("select count(*) from facts")).rows[0].count);
console.log(JSON.stringify({
  facts: total, requests: N_REQ, concurrency: CONC,
  p50_ms: pct(50), p95_ms: pct(95), p99_ms: pct(99), max_ms: latencies.at(-1)!.toFixed(1),
  rps: (N_REQ / wall).toFixed(0), modes: Object.fromEntries(modes), with_results: hits,
}, null, 1));
await app.close();
await pool.end();
