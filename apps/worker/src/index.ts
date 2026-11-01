/**
 * hive-worker: claims distill jobs from the hive, runs the fact agent on each episode, and posts the facts back.
 *   HIVE_URL, HIVE_TOKEN (a `worker` role token), HIVE_DISTILL_RUNNER=claude|ollama|hermes, HIVE_DISTILL_MODEL,
 *   OLLAMA_URL (ollama runner).
 */
import { ClaudeAuth } from "./auth.js";
import { HiveClient } from "./client.js";
import { exec } from "./exec.js";
import { runLoop, type LoopDeps } from "./loop.js";
import { loadPrompt } from "./prompt.js";
import { ClaudeRunner } from "./runners/claude.js";
import { HermesRunner } from "./runners/hermes.js";
import { OllamaRunner } from "./runners/ollama.js";
import type { Runner } from "./runners/types.js";

const env = process.env;
const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stop.abort();
    process.exit(0);
  });
}

const url = env.HIVE_URL || "http://127.0.0.1:8800";
const token = env.HIVE_TOKEN ?? "";
const runnerName = env.HIVE_DISTILL_RUNNER || "claude";
const model = env.HIVE_DISTILL_MODEL || undefined;

if (!token) {
  // Not a crash: compose would restart us in a loop. Idle until someone sets the token and recreates the container.
  console.log("HIVE_TOKEN is not set (mint a worker token: scripts/setup.sh); idling");
  setInterval(() => {}, 1 << 30);
} else {
  let runner: Runner;
  let auth: LoopDeps["auth"];
  if (runnerName === "claude") {
    runner = new ClaudeRunner(exec, model);
    const claudeAuth = new ClaudeAuth(exec);
    auth = (credential) => claudeAuth.check(credential);
  } else if (runnerName === "ollama") {
    runner = new OllamaRunner(env.OLLAMA_URL || "http://127.0.0.1:11434", model);
  } else if (runnerName === "hermes") {
    runner = new HermesRunner(exec); // model and provider come from the Hermes profile
  } else {
    console.error(`HIVE_DISTILL_RUNNER must be claude, ollama or hermes, got ${runnerName}`);
    process.exit(2);
  }
  const prompt = loadPrompt();
  console.log(`hive-worker: ${url}, runner=${runnerName} model=${runner.model} prompt=${prompt.version}`);
  await runLoop({ hive: new HiveClient(url, token), runner, prompt, auth }, stop.signal);
}
