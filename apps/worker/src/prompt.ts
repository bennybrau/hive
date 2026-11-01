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

export function renderPrompt(prompt: Prompt, repoKey: string | null): string {
  const scopes = repoKey
    ? `"repo:${repoKey}" for facts about this repo, "global" for facts that hold across repos.`
    : `"global".`;
  return prompt.body.replaceAll("{{scopes}}", scopes);
}

/** The JSON object in a model reply, tolerating code fences or prose around it. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
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
