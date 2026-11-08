/**
 * Distill eval: runs the worker's own distill (same runner, prompt, chunking and fact parsing as a real job) over
 * the labelled transcripts in scripts/eval-distill/cases and scores what comes back.
 *
 *   node dist/eval/run.js [--cases DIR] [--only id,id] [--repeat N] [--concurrency N] [--json FILE]
 *
 * Env: CLAUDE_CODE_OAUTH_TOKEN (the subscription token), HIVE_DISTILL_RUNNER / HIVE_DISTILL_MODEL as for the worker
 * (OLLAMA_URL for the ollama runner). Proposed facts are matched to labels by a claude judge
 * (HIVE_EVAL_JUDGE_MODEL, default the worker's claude model), which always runs on the subscription token.
 * Run it with scripts/eval-distill.sh, which does this inside the hive-worker image.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClaudeAuth } from "../auth.js";
import { exec } from "../exec.js";
import { distill, type LoopDeps } from "../loop.js";
import { loadPrompt } from "../prompt.js";
import { ClaudeRunner } from "../runners/claude.js";
import { HermesRunner } from "../runners/hermes.js";
import { OllamaRunner } from "../runners/ollama.js";
import type { Runner } from "../runners/types.js";
import { assign, distillView, judgePrompt, parseJudge, questionsOnly, quoteValid, totals, type CaseResult, type EvalCase, type Label } from "./score.js";

const { values: args } = parseArgs({
  options: {
    cases: { type: "string", default: "/eval/cases" },
    only: { type: "string" },
    repeat: { type: "string", default: "1" },
    concurrency: { type: "string", default: "3" },
    json: { type: "string" },
  },
});
const env = process.env;
const JUDGE_SYSTEM_PROMPT = "You match proposed facts to labels; follow the user message; reply with JSON only.";
const ollamaUrl = (env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

function loadCases(dir: string, only?: string): EvalCase[] {
  const want = only ? new Set(only.split(",")) : null;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as Omit<EvalCase, "transcript">;
      return { ...meta, acceptable: meta.acceptable ?? [], transcript: readFileSync(join(dir, f.replace(/\.json$/, ".txt")), "utf8") };
    })
    .filter((c) => !want || want.has(c.id));
}

async function judge(judgeRunner: Runner, c: EvalCase, texts: string[], credential: string) {
  if (!texts.length) return { matches: [], cost_usd: 0 };
  const { json, usage } = await judgeRunner.run(judgePrompt(texts, c.expected.map((l) => l.text), c.acceptable.map((l) => l.text)), "", credential);
  return { matches: parseJudge(json, texts.length), cost_usd: usage.cost_usd };
}

async function runCase(deps: LoopDeps, judgeRunner: Runner, c: EvalCase, credential: string): Promise<CaseResult> {
  const base: CaseResult = {
    id: c.id, proposed: [], expected: c.expected.length, found: 0, falsePositives: 0, invalidQuotes: 0, scopeMisses: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0,
  };
  const kind = c.kind ?? "session";
  // as the hive's claim: a questions-only session finishes with no model call, the rest get the distill view
  if ((kind === "session" || kind === "turn") && questionsOnly(c.transcript)) return { ...base, skipped: true };
  try {
    const { facts, usage } = await distill(deps, {
      job: { id: `eval-${c.id}`, attempts: 1, lease_until: "" },
      episode: { id: c.id, kind, repo_key: c.repo_key, content: distillView(c.transcript), remember_request: false, personal_scope: null },
      prompt_version: deps.prompt.version,
      credential,
    });
    const j = await judge(judgeRunner, c, facts.map((f) => f.text), credential);
    const { verdicts, found } = assign(j.matches, c.expected.length, c.acceptable.length, { proposed: facts.map((f) => f.scope), expected: c.expected.map((l) => l.scope) });
    const proposed = facts.map((fact, i) => ({ fact, verdict: verdicts[i]!, quoteOk: quoteValid(fact.quote, c.transcript) }));
    return {
      ...base,
      proposed,
      found: found.filter(Boolean).length,
      falsePositives: verdicts.filter((v) => v.kind === "false_positive").length,
      invalidQuotes: proposed.filter((p) => !p.quoteOk).length,
      scopeMisses: verdicts.filter((v) => v.kind === "match" && !v.scopeOk).length,
      input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_tokens: usage.cache_read_tokens,
      cost_usd: usage.cost_usd, judge_cost_usd: j.cost_usd, duration_ms: usage.duration_ms,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message.replaceAll(credential || "\0", "[credential]") : String(err) };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `$${x.toFixed(3)}`;
const ok = (b: boolean) => (b ? "PASS" : "FAIL");

function report(results: CaseResult[], cases: EvalCase[], label: string): void {
  const byId = new Map(cases.map((c) => [c.id, c]));
  console.log(`\n=== ${label}`);
  console.log("case                     found  FP  bad-quote  scope-miss  tokens in/out     cost    secs");
  for (const r of results) {
    const line = `${r.id.padEnd(24)} ${`${r.found}/${r.expected}`.padStart(5)}  ${String(r.falsePositives).padStart(2)}  ${String(r.invalidQuotes).padStart(9)}  ${String(r.scopeMisses).padStart(10)}  ${`${r.input_tokens + r.cache_read_tokens}/${r.output_tokens}`.padStart(13)}  ${usd(r.cost_usd).padStart(7)}  ${(r.duration_ms / 1000).toFixed(1).padStart(6)}`;
    console.log(line + (r.skipped ? "  SKIPPED (questions only)" : "") + (r.error ? `  ERROR ${r.error.slice(0, 160)}` : ""));
    const c = byId.get(r.id)!;
    for (const p of r.proposed) {
      const v = p.verdict;
      const tag =
        v.kind === "match" ? `  + E${v.label + 1}${v.scopeOk ? "" : ` scope ${p.fact.scope}≠${c.expected[v.label]!.scope}`}`
        : v.kind === "acceptable" ? `  ~ ${v.label < 0 ? "dup" : `A${v.label + 1}`}`
        : "  - FP";
      console.log(`${tag}${p.quoteOk ? "" : " BAD-QUOTE"} [${p.fact.kind}/${p.fact.scope}] ${p.fact.text}`);
    }
    const foundSet = new Set(r.proposed.flatMap((p) => (p.verdict.kind === "match" ? [p.verdict.label] : [])));
    c.expected.forEach((l: Label, i) => { if (!foundSet.has(i)) console.log(`  ? missed [${l.kind}/${l.scope}] ${l.text}`); });
  }
  const t = totals(results);
  console.log("\nTOTAL");
  console.log(`  expected facts found  ${t.found}/${t.expected} (${pct(t.recall)})   target >= 75%   ${ok(t.pass.recall)}`);
  console.log(`  false positives       ${t.falsePositives} in ${t.cases} sessions = ${t.fpPer5.toFixed(2)} per 5   target <= 1   ${ok(t.pass.falsePositives)}`);
  console.log(`  invalid quotes        ${t.invalidQuotes}   target 0   ${ok(t.pass.quotes)}`);
  console.log(`  scope misses          ${t.scopeMisses} of ${t.found} found facts`);
  console.log(`  errors                ${t.errors}`);
  const distilled = results.filter((r) => !r.skipped);
  const mean = (f: (r: CaseResult) => number) => Math.round(distilled.reduce((n, r) => n + f(r), 0) / (distilled.length || 1));
  console.log(`  skipped               ${results.length - distilled.length} of ${results.length} cases (questions only)`);
  console.log(`  mean input tokens     ${mean((r) => r.input_tokens + r.cache_read_tokens)} per distilled case (${mean((r) => r.input_tokens)} fresh + ${mean((r) => r.cache_read_tokens)} cached)`);
  console.log(`  tokens                ${t.input_tokens} in, ${t.output_tokens} out; distill cost ${usd(t.cost_usd)} (+ judge ${usd(results.reduce((n, r) => n + (r.judge_cost_usd ?? 0), 0))})`);
}

async function main(): Promise<void> {
  const runnerName = env.HIVE_DISTILL_RUNNER || "claude";
  const model = env.HIVE_DISTILL_MODEL || undefined;
  const credential = env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  let runner: Runner;
  if (runnerName === "claude") {
    if (!credential) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set");
    await new ClaudeAuth(exec).check(credential);
    runner = new ClaudeRunner(exec, model);
  } else if (runnerName === "ollama") runner = new OllamaRunner(ollamaUrl, model);
  else if (runnerName === "hermes") runner = new HermesRunner(exec);
  else throw new Error(`HIVE_DISTILL_RUNNER must be claude, ollama or hermes, got ${runnerName}`);
  const prompt = loadPrompt();
  const cases = loadCases(args.cases!, args.only);
  if (!cases.length) throw new Error(`no cases in ${args.cases}`);
  if (!credential) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set (the judge runs on claude)");
  const judgeRunner = new ClaudeRunner(exec, env.HIVE_EVAL_JUDGE_MODEL || undefined, env, JUDGE_SYSTEM_PROMPT);
  console.log(`distill eval: ${cases.length} cases, runner=${runnerName} model=${runner.model} prompt=${prompt.version} judge=${judgeRunner.model}`);
  const deps: LoopDeps = { hive: undefined as never, runner, prompt };
  const runs: CaseResult[][] = [];
  for (let i = 0; i < Number(args.repeat); i++) {
    const results = await pool(cases, Number(args.concurrency), (c) => runCase(deps, judgeRunner, c, credential));
    report(results, cases, `run ${i + 1}/${args.repeat}  (${prompt.version}, ${runner.model})`);
    runs.push(results);
  }
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ prompt: prompt.version, model: runner.model, judge: judgeRunner.model, runs: runs.map((r) => ({ results: r, totals: totals(r) })) }, null, 2));
  }
  const all = totals(runs.flat());
  process.exitCode = all.pass.recall && all.pass.falsePositives && all.pass.quotes ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
