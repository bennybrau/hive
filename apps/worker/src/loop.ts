import { chunkTranscript } from "./chunk.js";
import type { Claimed, HiveClient } from "./client.js";
import { allowedScopes, anchorQuote, parseFacts, renderPrompt, type DistilledFact, type Prompt } from "./prompt.js";
import type { Runner, Usage } from "./runners/types.js";

/** The complete endpoint takes at most this many facts per job. */
export const MAX_FACTS = 20;
/** How long to wait after a 503 (no agent credential) or an unreachable hive before claiming again. */
export const BACKOFF_MS = 30_000;

export interface LoopDeps {
  hive: Pick<HiveClient, "claim" | "complete" | "fail">;
  runner: Runner;
  prompt: Prompt;
  /** Throws if the credential must not be used (claude: not an OAuth token). */
  auth?: (credential: string) => Promise<void>;
  log?: (msg: string) => void;
}

export type Step = "idle" | "unavailable" | "completed" | "failed" | "conflict";

/** One claim and, if a job came back, its distill: complete, or fail with the reason. */
export async function step(deps: LoopDeps): Promise<Step> {
  const log = deps.log ?? console.log;
  const res = await deps.hive.claim();
  if (res.kind === "none") return "idle";
  if (res.kind === "unavailable") {
    log(`hive not handing out jobs: ${res.error}`);
    return "unavailable";
  }
  const { claim } = res;
  const id = claim.job.id;
  // The credential must never reach a log or the hive: scrub it from anything we report.
  const scrub = (s: string) => (claim.credential ? s.replaceAll(claim.credential, "[credential]") : s);

  let body: { facts: DistilledFact[]; usage: Usage };
  try {
    if (claim.prompt_version !== deps.prompt.version) {
      throw new Error(`prompt version mismatch: hive wants ${claim.prompt_version}, worker has ${deps.prompt.version}`);
    }
    await deps.auth?.(claim.credential);
    body = await distill(deps, claim);
    if ((await deps.hive.complete(id, body)) === "conflict") return conflict(log, id);
  } catch (err) {
    const msg = scrub(err instanceof Error ? err.message : String(err));
    log(`job ${id} failed: ${msg}`);
    return (await deps.hive.fail(id, msg)) === "conflict" ? conflict(log, id) : "failed";
  }
  log(`job ${id} done: ${body.facts.length} facts, $${body.usage.cost_usd.toFixed(4)}`);
  return "completed";
}

function conflict(log: (msg: string) => void, id: string): Step {
  log(`job ${id}: 409, no longer ours (lease expired?); skipped`);
  return "conflict";
}

/** Run every chunk of the episode, keep valid facts (first of each text, at most MAX_FACTS), sum the usage. */
export async function distill(deps: LoopDeps, claim: Claimed): Promise<{ facts: DistilledFact[]; usage: Usage }> {
  const { episode } = claim;
  const scopes = allowedScopes(episode.repo_key, episode.personal_scope);
  const remember = episode.remember_request ? { personalScope: episode.personal_scope } : undefined;
  const related = claim.related ?? [];
  const relatedIds = related.map((f) => f.id);
  const prompt = renderPrompt(deps.prompt, episode.repo_key, episode.kind, remember, related);
  const usage: Usage = { model: deps.runner.model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0 };
  const facts: DistilledFact[] = [];
  const seen = new Set<string>();
  for (const chunk of chunkTranscript(episode.content)) {
    const res = await deps.runner.run(prompt, chunk, claim.credential);
    usage.model = res.usage.model;
    usage.input_tokens += res.usage.input_tokens;
    usage.output_tokens += res.usage.output_tokens;
    usage.cache_read_tokens += res.usage.cache_read_tokens;
    usage.cost_usd += res.usage.cost_usd;
    usage.duration_ms += res.usage.duration_ms;
    for (const parsed of parseFacts(res.json, scopes, relatedIds)) {
      // An unrepairable quote is passed on as is: the hive drops that fact and records why.
      const f = { ...parsed, quote: anchorQuote(parsed.quote, chunk) ?? parsed.quote };
      const key = f.text.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(f);
    }
  }
  return { facts: facts.slice(0, MAX_FACTS), usage };
}

/** Claim and distill until `signal` aborts. Never throws: errors are logged and retried after a back-off. */
export async function runLoop(deps: LoopDeps, signal: AbortSignal, sleep = abortableSleep): Promise<void> {
  const log = deps.log ?? console.log;
  while (!signal.aborted) {
    try {
      if ((await step(deps)) === "unavailable") await sleep(BACKOFF_MS, signal);
    } catch (err) {
      log(`worker error: ${err instanceof Error ? err.message : String(err)}; retrying in ${BACKOFF_MS / 1000}s`);
      await sleep(BACKOFF_MS, signal);
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}
