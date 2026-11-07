/**
 * Experiment judge (scripts/experiment): grades each saved answer against its question's answer key.
 *
 *   node dist/experiment/judge.js --questions FILE --dir DIR [--concurrency N]
 *
 * Reads DIR/plan.tsv (question, arm, run) and DIR/runs/<question>.<arm>.<run>.answer.txt, written by
 * scripts/experiment/run.sh, and writes DIR/judge.jsonl: one line per run with the verdict per key point, notes, and
 * the judge's own cost (kept apart from the arms' cost). The judge never sees the arm. Env: CLAUDE_CODE_OAUTH_TOKEN,
 * HIVE_EXPERIMENT_JUDGE_MODEL (default claude-sonnet-5-5, pinned so runs are comparable). Run it via run.sh, which
 * does this inside the hive-worker image.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ClaudeAuth } from "../auth.js";
import { exec } from "../exec.js";
import { ClaudeRunner } from "../runners/claude.js";
import type { Runner } from "../runners/types.js";

export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";

export interface Question {
  id: string;
  question: string;
  key: string[];
  where: string;
}

export interface Verdict {
  correct: boolean;
  /** One per key point: did the answer state it. */
  points: boolean[];
  /** Statements in the answer that contradict the key. */
  contradictions: string[];
  notes: string;
}

/** The rubric: every key point present (wording may differ) and nothing contradicting them. */
export function judgePrompt(q: Question, answer: string): string {
  const key = q.key.map((k, i) => `K${i + 1}: ${k}`).join("\n");
  const none = q.where === "none"
    ? `\nThe thing asked about does not exist. The answer must say so; an answer that describes one as if it existed
contradicts the key, even when it hedges.\n`
    : "";
  return `You grade an answer to a question about a codebase against an answer key. Do not use tools.

For each key point, decide whether the answer states it. Wording may differ and extra detail is fine; a vague
gesture at the topic is not the point. Then list every statement in the answer that contradicts a key point
(a different value, owner, endpoint, reason, or a claim the key rules out). Leave the list empty if there are none.
${none}
Reply with JSON only:
{"points":[{"k":1,"present":true},{"k":2,"present":false}],"contradictions":["..."],"notes":"one or two sentences"}
with one entry per key point.

Question: ${q.question}

Answer key:
${key}

Answer to grade:
<answer>
${answer.trim() || "(empty)"}
</answer>
`;
}

/** Read the judge's reply. Correct only when every point is present and nothing contradicts; malformed = incorrect. */
export function parseVerdict(json: unknown, nPoints: number): Verdict {
  const points: boolean[] = Array.from({ length: nPoints }, () => false);
  const r = json as { points?: unknown; contradictions?: unknown; notes?: unknown } | null;
  if (!r || !Array.isArray(r.points) || !Array.isArray(r.contradictions)) {
    return { correct: false, points, contradictions: [], notes: `malformed judge reply: ${JSON.stringify(json)?.slice(0, 200)}` };
  }
  for (const p of r.points as { k?: unknown; present?: unknown }[]) {
    const i = Number(p?.k) - 1;
    if (Number.isInteger(i) && i >= 0 && i < nPoints && p.present === true) points[i] = true;
  }
  const contradictions = r.contradictions.filter((c): c is string => typeof c === "string" && c.trim() !== "");
  const notes = typeof r.notes === "string" ? r.notes : "";
  return { correct: points.every(Boolean) && contradictions.length === 0, points, contradictions, notes };
}

/** judge.jsonl's notes column: the judge's notes, then what was missing or contradicted. */
export function noteLine(v: Verdict): string {
  const missing = v.points.flatMap((ok, i) => (ok ? [] : [`K${i + 1}`]));
  return [v.notes, missing.length ? `missing ${missing.join(",")}` : "", ...v.contradictions.map((c) => `contradicts: ${c}`)]
    .filter(Boolean)
    .join(" | ");
}

export async function judge(runner: Runner, q: Question, answer: string, credential: string): Promise<Verdict & { judge_cost_usd: number }> {
  try {
    const { json, usage } = await runner.run(judgePrompt(q, answer), "", credential);
    return { ...parseVerdict(json, q.key.length), judge_cost_usd: usage.cost_usd };
  } catch (err) {
    const msg = err instanceof Error ? err.message.replaceAll(credential || "\0", "[credential]") : String(err);
    return { correct: false, points: q.key.map(() => false), contradictions: [], notes: `judge error: ${msg.slice(0, 200)}`, judge_cost_usd: 0 };
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      questions: { type: "string", default: "/exp/questions.json" },
      dir: { type: "string", default: "/exp/out" },
      concurrency: { type: "string", default: "4" },
    },
  });
  const credential = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  if (!credential) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set");
  await new ClaudeAuth(exec).check(credential);
  const runner = new ClaudeRunner(exec, process.env.HIVE_EXPERIMENT_JUDGE_MODEL || DEFAULT_JUDGE_MODEL);
  const questions = new Map(
    (JSON.parse(readFileSync(args.questions!, "utf8")) as { questions: Question[] }).questions.map((q) => [q.id, q]),
  );
  const plan = readFileSync(join(args.dir!, "plan.tsv"), "utf8").trim().split("\n").map((l) => l.split("\t") as [string, string, string]);
  console.log(`judge: ${plan.length} answers, model=${runner.model}`);
  const out: string[] = new Array(plan.length);
  let next = 0;
  let spent = 0;
  await Promise.all(Array.from({ length: Math.min(Number(args.concurrency), plan.length) }, async () => {
    while (next < plan.length) {
      const i = next++;
      const [id, arm, run] = plan[i]!;
      const q = questions.get(id);
      if (!q) throw new Error(`plan names question ${id}, not in ${args.questions}`);
      const answer = readFileSync(join(args.dir!, "runs", `${id}.${arm}.${run}.answer.txt`), "utf8");
      const v = await judge(runner, q, answer, credential);
      spent += v.judge_cost_usd;
      console.log(`  ${id} ${arm} ${run}: ${v.correct ? "correct" : "incorrect"}`);
      out[i] = JSON.stringify({ question: id, arm, run: Number(run), model: runner.model, correct: v.correct, points: v.points, contradictions: v.contradictions, notes: noteLine(v), judge_cost_usd: v.judge_cost_usd });
    }
  }));
  writeFileSync(join(args.dir!, "judge.jsonl"), out.join("\n") + "\n");
  console.log(`judge cost $${spent.toFixed(4)} (not counted in either arm)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
