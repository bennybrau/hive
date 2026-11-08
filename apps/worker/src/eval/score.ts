/**
 * Scoring for the distill eval (scripts/eval-distill). Pure: the judge's answers come in as data, so this is
 * unit-tested without a model.
 */
import type { DistilledFact, RelatedFact } from "../prompt.js";

export interface Label {
  text: string;
  kind: string;
  scope: string;
  evidence?: string;
  /** The id of the `related` fact this label corrects. */
  replaces?: string;
}

export interface EvalCase {
  id: string;
  repo_key: string | null;
  /** The episode kind the case is distilled as (default `session`). */
  kind?: string;
  /** Facts a curator would accept: each one found counts toward recall. */
  expected: Label[];
  /** Borderline facts: proposing one is neither credited nor a false positive. */
  acceptable: Label[];
  /** The active facts a claim would send with this episode (default none). */
  related?: RelatedFact[];
  transcript: string;
}

/** Same as the hive's normalizeText (apps/hive/src/facts.ts), which is how the server checks a quote. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const CLARIFY_PREFIX = "tool(clarify): ";
const USER_RESPONSE = /"user_response":\s*"((?:[^"\\]|\\.)*)"/g;

/** Same as the hive's userTurns (apps/hive/src/distill.ts): a session fact's quote must sit in one of these. */
export function userTurns(content: string): string[] {
  const turns: string[] = [];
  let turn: string[] | null = null;
  for (const line of content.split("\n")) {
    if (line.startsWith("user: ")) {
      if (turn) turns.push(turn.join("\n"));
      turn = [line];
    } else if (line.startsWith("assistant") || line.startsWith("tool(")) {
      if (turn) turns.push(turn.join("\n"));
      turn = null;
      if (line.startsWith(CLARIFY_PREFIX)) for (const m of line.matchAll(USER_RESPONSE)) turns.push(m[1]!);
    } else turn?.push(line);
  }
  if (turn) turns.push(turn.join("\n"));
  return turns;
}

const NOT_PLAIN_MARKERS = [
  "instead", "actually", "rather", "don't", "do not", "never", "always", "from now on", "let's", "should be", "must",
  "i want", "i'd like", "please", "remember", "no,", "not ",
];

/** Same as the hive's isPlainQuestion (apps/hive/src/distill.ts). */
export function isPlainQuestion(turn: string): boolean {
  if (!turn.startsWith("user: ")) return false;
  const text = turn.slice("user: ".length).trim().toLowerCase().replaceAll("’", "'");
  return text.endsWith("?") && !NOT_PLAIN_MARKERS.some((m) => text.includes(m));
}

/** Same as the hive's questionsOnly (apps/hive/src/distill.ts): the hive skips such a session with no model call. */
export function questionsOnly(content: string): boolean {
  return userTurns(content).every(isPlainQuestion);
}

const VIEW_ASSISTANT_CHARS = 2000;

/** Same as the hive's distillView (apps/hive/src/distill.ts): what the claim sends the distiller. */
export function distillView(content: string): string {
  const blocks: { kind: "user" | "assistant" | "other"; lines: string[] }[] = [];
  for (const line of content.split("\n")) {
    const kind =
      line.startsWith("user: ") || line.startsWith(CLARIFY_PREFIX)
        ? "user"
        : line.startsWith("assistant: ")
          ? "assistant"
          : line.startsWith("assistant") || line.startsWith("tool(")
            ? "other"
            : null;
    if (kind) blocks.push({ kind, lines: [line] });
    else if (blocks.length) blocks.at(-1)!.lines.push(line);
    else blocks.push({ kind: "other", lines: [line] });
  }
  const keep = blocks.map(() => false);
  let lastKept = -1;
  blocks.forEach((b, i) => {
    if (b.kind !== "user") return;
    for (let j = i - 1; j > lastKept; j--) {
      if (blocks[j]!.kind === "assistant") {
        keep[j] = true;
        break;
      }
    }
    keep[i] = true;
    lastKept = i;
  });
  const out: string[] = [];
  blocks.forEach((b, i) => {
    if (!keep[i]) {
      if (i === 0 || keep[i - 1]) out.push("…");
      return;
    }
    const text = b.lines.join("\n");
    if (b.kind !== "assistant") return out.push(text);
    const body = text.slice("assistant: ".length);
    out.push(body.length > VIEW_ASSISTANT_CHARS ? `assistant: […]${body.slice(-VIEW_ASSISTANT_CHARS)}` : text);
  });
  return out.join("\n");
}

/** The server keeps a session fact only when its quote (whitespace collapsed) is inside a user turn. */
export function quoteValid(quote: string, transcript: string): boolean {
  const q = normalizeText(quote);
  return q.length > 0 && userTurns(transcript).some((t) => normalizeText(t).includes(q));
}

/** A judge's answer for one proposed fact: the label it states ("E1".."En" expected, "A1".."Am" acceptable) or null. */
export type JudgeMatch = string | null;

export type Verdict =
  | { kind: "match"; label: number; scopeOk: boolean }
  | { kind: "acceptable"; label: number }
  | { kind: "false_positive" };

/**
 * Turn the judge's per-proposal answers into verdicts. Each expected label is credited once (to the first proposal
 * naming it); a later proposal naming an already-found label repeats a found fact: noise for the curator, but the
 * dedupe's job, not a false fact, so it is neutral (label -1). A proposal naming an acceptable label is neutral. An
 * answer that names no known label counts as no match: the judge can't make a fact true by inventing a label.
 */
export function assign(
  matches: JudgeMatch[],
  nExpected: number,
  nAcceptable: number,
  scopes: { proposed: string[]; expected: string[] },
): { verdicts: Verdict[]; found: boolean[] } {
  const found = Array.from({ length: nExpected }, () => false);
  const verdicts = matches.map((m, p): Verdict => {
    const hit = /^([EA])(\d+)$/.exec(m ?? "");
    const i = hit ? Number(hit[2]) - 1 : -1;
    if (hit?.[1] === "E" && i >= 0 && i < nExpected) {
      if (found[i]) return { kind: "acceptable", label: -1 };
      found[i] = true;
      return { kind: "match", label: i, scopeOk: scopes.proposed[p] === scopes.expected[i] };
    }
    if (hit?.[1] === "A" && i >= 0 && i < nAcceptable) return { kind: "acceptable", label: i };
    return { kind: "false_positive" };
  });
  return { verdicts, found };
}

/** The judge's prompt: matching is by meaning, which embeddings can't separate from "same topic". */
export function judgePrompt(proposed: string[], expected: string[], acceptable: string[]): string {
  const list = (tag: string, xs: string[]) => xs.map((t, i) => `${tag}${i + 1}: ${t}`).join("\n") || "(none)";
  return `You check a fact extractor against reference labels. For each proposed fact, name the ONE label that states
the same core claim (same decision, rule or trap, about the same thing), or null if none does. Wording, extra
detail, a missing reason or a different level of detail don't matter; a different claim on the same topic is null.
If a proposal bundles several claims, name the label for its main claim. Do not use tools.

Reply with JSON only: {"matches":[{"p":1,"label":"E2"},{"p":2,"label":null}]} with one entry per proposed fact.

Expected labels:
${list("E", expected)}

Acceptable labels:
${list("A", acceptable)}

Proposed facts:
${list("P", proposed)}
`;
}

/** Read the judge's reply into one answer per proposal; anything missing or malformed is null (no match). */
export function parseJudge(json: unknown, n: number): JudgeMatch[] {
  const out: JudgeMatch[] = Array.from({ length: n }, () => null);
  const ms = (json as { matches?: unknown })?.matches;
  if (!Array.isArray(ms)) throw new Error("judge reply has no matches array");
  for (const m of ms as { p?: unknown; label?: unknown }[]) {
    const p = Number(m?.p) - 1;
    if (Number.isInteger(p) && p >= 0 && p < n && typeof m.label === "string") out[p] = m.label.trim().toUpperCase();
  }
  return out;
}

export interface CaseResult {
  id: string;
  proposed: { fact: DistilledFact; verdict: Verdict; quoteOk: boolean }[];
  expected: number;
  found: number;
  falsePositives: number;
  invalidQuotes: number;
  scopeMisses: number;
  /** Found facts whose `replaces` differs from their label's. */
  replacesMisses: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  judge_cost_usd?: number;
  duration_ms: number;
  /** Skipped as the hive would (questions only): no model call. */
  skipped?: boolean;
  error?: string;
}

export interface Totals {
  cases: number;
  expected: number;
  found: number;
  falsePositives: number;
  invalidQuotes: number;
  scopeMisses: number;
  replacesMisses: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  errors: number;
  recall: number;
  fpPer5: number;
  pass: { recall: boolean; falsePositives: boolean; quotes: boolean };
}

/** The ticket's bar: >= 3/4 expected facts found, <= 1 false positive per 5 sessions, 0 invalid quotes. */
export function totals(results: CaseResult[]): Totals {
  const sum = (f: (r: CaseResult) => number) => results.reduce((n, r) => n + f(r), 0);
  const expected = sum((r) => r.expected);
  const found = sum((r) => r.found);
  const falsePositives = sum((r) => r.falsePositives);
  const invalidQuotes = sum((r) => r.invalidQuotes);
  const recall = expected ? found / expected : 1;
  const fpPer5 = results.length ? (falsePositives / results.length) * 5 : 0;
  const errors = results.filter((r) => r.error).length;
  return {
    cases: results.length,
    expected,
    found,
    falsePositives,
    invalidQuotes,
    scopeMisses: sum((r) => r.scopeMisses),
    replacesMisses: sum((r) => r.replacesMisses),
    cost_usd: sum((r) => r.cost_usd),
    input_tokens: sum((r) => r.input_tokens),
    output_tokens: sum((r) => r.output_tokens),
    errors,
    recall,
    fpPer5,
    pass: { recall: recall >= 0.75 && errors === 0, falsePositives: fpPer5 <= 1, quotes: invalidQuotes === 0 },
  };
}
