import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnEnv } from "../env.js";
import type { Exec } from "../exec.js";
import { extractJson } from "../prompt.js";
import { cost, count, RUN_TIMEOUT_MS, type RunResult, type Runner, type Usage } from "./types.js";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5";

interface Envelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

/** The reply text and usage from `claude -p --output-format json`'s result envelope. */
export function parseEnvelope(stdout: string, model: string): { text: string; usage: Usage } {
  let env: Envelope;
  try {
    env = JSON.parse(stdout) as Envelope;
  } catch {
    throw new Error(`claude: output is not a JSON envelope: ${stdout.slice(0, 200)}`);
  }
  if (env.is_error || env.subtype !== "success" || typeof env.result !== "string") {
    throw new Error(`claude: ${env.subtype ?? "error"}: ${String(env.result ?? "").slice(0, 500)}`);
  }
  const u = env.usage ?? {};
  return {
    text: env.result,
    usage: {
      model,
      input_tokens: count(u.input_tokens) + count(u.cache_creation_input_tokens),
      output_tokens: count(u.output_tokens),
      cache_read_tokens: count(u.cache_read_input_tokens),
      cost_usd: cost(env.total_cost_usd),
      duration_ms: count(env.duration_ms),
    },
  };
}

/** `claude -p` on the curator's subscription token, one turn, in an empty directory. */
export class ClaudeRunner implements Runner {
  constructor(
    private exec: Exec,
    readonly model = DEFAULT_CLAUDE_MODEL,
    private baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(prompt: string, input: string, credential: string): Promise<RunResult> {
    const cwd = await mkdtemp(join(tmpdir(), "distill-"));
    try {
      const res = await this.exec(
        "claude",
        ["-p", "--output-format", "json", "--max-turns", "1", "--model", this.model],
        { input: `${prompt}\n${input}\n`, env: spawnEnv(this.baseEnv, credential), cwd, timeoutMs: RUN_TIMEOUT_MS },
      );
      if (res.code !== 0 && !res.stdout.trim()) throw new Error(`claude exited ${res.code}: ${res.stderr.slice(0, 500)}`);
      const { text, usage } = parseEnvelope(res.stdout, this.model);
      return { json: extractJson(text), usage };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
