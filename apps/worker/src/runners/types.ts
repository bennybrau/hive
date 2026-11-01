/** What one model call cost; the shape of the hive's `usage` on complete. */
export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

export interface RunResult {
  json: unknown;
  usage: Usage;
}

export interface Runner {
  /** The model named in usage when no call is made (an empty episode). */
  model: string;
  /** Send `prompt` followed by `input` (one transcript chunk); return the reply's JSON object and the call's usage. */
  run(prompt: string, input: string, credential: string): Promise<RunResult>;
}

export const RUN_TIMEOUT_MS = 5 * 60_000;

/** Non-negative integer, else 0: usage fields from a CLI or API may be missing. */
export function count(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function cost(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}
