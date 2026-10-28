export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  version: string;
  /** Ollama base URL; empty string disables meaning search (keyword-only). */
  ollamaUrl: string;
  embedModel: string;
  /** Vector hits below this cosine similarity are dropped, so unrelated facts never pad a recall. */
  vectorMinSimilarity: number;
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number, ok: (n: number) => boolean): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!ok(n)) throw new Error(`${key} is invalid: ${raw}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env (or run scripts/setup.sh).");
  }
  return {
    databaseUrl,
    host: env.HIVE_HOST ?? "127.0.0.1",
    port: num(env, "HIVE_PORT", 8800, (n) => Number.isInteger(n) && n > 0),
    version: env.HIVE_VERSION ?? "0.0.1",
    ollamaUrl: env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    embedModel: env.HIVE_EMBED_MODEL ?? "nomic-embed-text",
    vectorMinSimilarity: num(env, "HIVE_VECTOR_MIN_SIM", 0.55, (n) => n >= 0 && n <= 1),
  };
}
