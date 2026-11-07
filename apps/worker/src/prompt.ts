import { readFileSync } from "node:fs";

/** Must match the hive's FACT_KINDS (apps/hive/src/facts.ts); the complete endpoint rejects anything else. */
export const FACT_KINDS = ["decision", "invariant", "gotcha", "preference", "convention", "system"] as const;

export interface DistilledFact {
  text: string;
  kind: (typeof FACT_KINDS)[number];
  scope: string;
  quote: string;
  locus?: string[];
}

export interface Prompt {
  version: string;
  body: string;
}

export const PROMPT_PATH = new URL("../prompts/distill.md", import.meta.url);

/** The prompt file: a `version:` frontmatter line (compared with the claim's prompt_version), then the body. */
export function loadPrompt(path: URL | string = PROMPT_PATH): Prompt {
  const raw = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const version = m && /^version:\s*(\S+)\s*$/m.exec(m[1]!)?.[1];
  if (!m || !version) throw new Error(`${String(path)}: no "version:" frontmatter`);
  return { version, body: m[2]! };
}

/** Scopes a fact from this episode may take: `global`, plus `repo:<key>` when the episode has a repo. */
export function allowedScopes(repoKey: string | null): string[] {
  return repoKey ? ["global", `repo:${repoKey}`] : ["global"];
}

/** What the transcript is, and where quotes may come from, per episode kind. */
const SOURCES: Record<string, { source: string; quoteRule: string }> = {
  session: {
    source: "a transcript of a conversation between a developer (user) and their coding agent (assistant)",
    quoteRule:
      "from a line that starts with `user:` or `assistant:`. Never quote `tool(...)` output or tool-call arguments: they hold escaped text that won't match",
  },
  asf_run: {
    source:
      "the record of a software-factory run: the approved plan for a change, then the review of the finished work. Keep the decisions it settled, with their reasons, and the gotchas and invariants the reviewer called out. Never turn a plan step (what the change does) into a fact; the code holds that",
    quoteRule: "from any line",
  },
};

export function renderPrompt(prompt: Prompt, repoKey: string | null, kind: string): string {
  const { source, quoteRule } = SOURCES[kind] ?? SOURCES.session!;
  const scopes = repoKey
    ? `"repo:${repoKey}" by default: anything about this repo's code, infrastructure, tooling or process. "global" only for facts that hold in any repo: a person's working preferences, or how a third-party tool behaves everywhere.`
    : `"global".`;
  return prompt.body.replaceAll("{{scopes}}", scopes).replaceAll("{{source}}", source).replaceAll("{{quote_rule}}", quoteRule);
}

/** The JSON object in a model reply, tolerating code fences or prose around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    // Prose with braces after the object, or a second object: take the first balanced object that parses.
    for (let at = start; at >= 0; at = text.indexOf("{", at + 1)) {
      const close = balancedEnd(text, at);
      if (close < 0) continue;
      try {
        return JSON.parse(text.slice(at, close + 1));
      } catch {
        /* not JSON; try the next "{" */
      }
    }
    throw err;
  }
}

/** Index of the "}" closing the object opened at `open`, skipping braces inside strings; -1 if it never closes. */
function balancedEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

/** The valid facts in a reply; anything malformed or out of scope is dropped. */
export function parseFacts(json: unknown, scopes: string[]): DistilledFact[] {
  const facts = (json as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) throw new Error('reply has no "facts" array');
  const out: DistilledFact[] = [];
  for (const f of facts as Record<string, unknown>[]) {
    if (!f || typeof f !== "object") continue;
    const { text, kind, scope, quote, locus } = f;
    if (typeof text !== "string" || text.trim().length < 3 || text.length > 2000) continue;
    if (!(FACT_KINDS as readonly unknown[]).includes(kind)) continue;
    if (typeof scope !== "string" || !scopes.includes(scope)) continue;
    if (typeof quote !== "string" || !quote.trim() || quote.length > 4000) continue;
    const fact: DistilledFact = { text: text.trim(), kind: kind as DistilledFact["kind"], scope, quote };
    if (Array.isArray(locus)) {
      const paths = locus.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 500).slice(0, 50);
      if (paths.length) fact.locus = paths;
    }
    out.push(fact);
  }
  return out;
}

const squash = (t: string) => t.replace(/\s+/g, " ").trim();

/** A regex for `words` in a rendered transcript: any whitespace, or a JSON-escaped \n \t \r, between words; `"` may be escaped. */
function spanPattern(words: string[]): RegExp {
  const sep = String.raw`(?:\s|\\[ntr])+`;
  const word = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, String.raw`\\?"`);
  return new RegExp(words.map(word).join(sep));
}

/**
 * A quote the hive will find in `chunk`, or null. The hive drops a fact whose quote isn't in the episode (after
 * collapsing whitespace), so repair the ways a model gets a quote mechanically wrong rather than lose the fact,
 * always returning a span copied from the chunk itself:
 * - it quotes tool-call arguments, which the transcript holds JSON-escaped (\n, \"), with the escapes undone;
 * - it rewords or trims the edges, or joins passages with "...": the longest verbatim run of its words is used,
 *   if that run is at least 6 words and half the quote, so a fact is never anchored to a stray fragment.
 */
export function anchorQuote(quote: string, chunk: string): string | null {
  if (squash(quote) && squash(chunk).includes(squash(quote))) return quote;
  const words = quote.split(/\s+|\\[ntr]|\.\.\.|\u2026/).filter(Boolean);
  if (!words.length) return null;
  const whole = spanPattern(words).exec(chunk);
  if (whole) return whole[0];
  const min = Math.max(6, Math.ceil(words.length / 2));
  for (let len = words.length - 1; len >= min; len--) {
    for (let at = 0; at + len <= words.length; at++) {
      const m = spanPattern(words.slice(at, at + len)).exec(chunk);
      if (m) return m[0];
    }
  }
  return null;
}
