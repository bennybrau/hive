import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../exec.js";
import { extractJson } from "../prompt.js";
import { cost, count, RUN_TIMEOUT_MS, type RunResult, type Runner } from "./types.js";

/**
 * `hermes -z` with its own configured model and provider, usage from `--usage-file`. Host-only: the image has
 * no Hermes, so run the worker with `pnpm --filter worker dev` on a machine that does.
 */
export class HermesRunner implements Runner {
  constructor(
    private exec: Exec,
    readonly model = "hermes",
  ) {}

  async run(prompt: string, input: string): Promise<RunResult> {
    const dir = await mkdtemp(join(tmpdir(), "distill-"));
    const usageFile = join(dir, "usage.json");
    const started = Date.now();
    try {
      const res = await this.exec("hermes", ["-z", `${prompt}\n${input}\n`, "--usage-file", usageFile], {
        cwd: dir,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      if (res.code !== 0) throw new Error(`hermes exited ${res.code}: ${res.stderr.slice(0, 500)}`);
      const u = JSON.parse(await readFile(usageFile, "utf8")) as Record<string, unknown>;
      return {
        json: extractJson(res.stdout),
        usage: {
          model: typeof u.model === "string" && u.model ? u.model : this.model,
          input_tokens: count(u.input_tokens),
          output_tokens: count(u.output_tokens),
          cache_read_tokens: count(u.cache_read_tokens),
          cost_usd: cost(u.estimated_cost_usd),
          duration_ms: Date.now() - started,
        },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
