import { extractJson } from "../prompt.js";
import { count, RUN_TIMEOUT_MS, type RunResult, type Runner } from "./types.js";

export const DEFAULT_OLLAMA_MODEL = "llama3.1";

/** A local Ollama model through `/api/chat` in JSON mode. Free: cost 0. */
export class OllamaRunner implements Runner {
  constructor(
    private baseUrl: string,
    readonly model = DEFAULT_OLLAMA_MODEL,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async run(prompt: string, input: string): Promise<RunResult> {
    const started = Date.now();
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        format: "json",
        stream: false,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: input },
        ],
      }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama /api/chat ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return {
      json: extractJson(body.message?.content ?? ""),
      usage: {
        model: this.model,
        input_tokens: count(body.prompt_eval_count),
        output_tokens: count(body.eval_count),
        cache_read_tokens: 0,
        cost_usd: 0,
        duration_ms: Date.now() - started,
      },
    };
  }
}
