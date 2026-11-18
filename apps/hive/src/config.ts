import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSecretKey } from "./secrets.js";

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
  /** Where registered repos are readable by the service (Docker: read-only mount at /repos). */
  reposRoot: string;
  /** The same directory as seen on the host, so repos can be registered by their host path. */
  reposHostRoot: string;
  /** Where repos registered by URL are cloned (Docker: the writable hive-clones volume). */
  clonesRoot: string;
  /** Accept file:// and local-path clone URLs. Tests only (HIVE_ALLOW_FILE_URLS=1). */
  allowFileUrls: boolean;
  /** Minutes between automatic ingest + verify passes over all repos; 0 = only on demand. */
  repoSyncMinutes: number;
  /** First ingest of a repo reads at most this many recent commits. */
  maxCommits: number;
  /** Encrypts stored secrets (the agent credential); null = those can't be set. */
  secretKey: Buffer | null;
  /** How long a claimed distill job belongs to its worker before it can be re-queued. */
  distillLeaseSeconds: number;
  /** A webhook delivery is `failed` after this many attempts. */
  webhookMaxAttempts: number;
  /** First webhook retry waits this long; each later one doubles (capped at an hour). */
  webhookBackoffSeconds: number;
  /** An active, unpinned fact is stale after this many days without a use or a keep. */
  staleDays: number;
  /** Built dashboard (index.html + assets); served at / when the directory exists. */
  dashboardDir: string;
  /** Telegram Bot API base URL (the review digest posts to `<url>/bot<token>/sendMessage`). */
  telegramApiUrl: string;
}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number, ok: (n: number) => boolean): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!ok(n)) throw new Error(`${key} is invalid: ${raw}`);
  return n;
}

/** HIVE_SECRET_KEY, else the contents of HIVE_SECRET_KEY_FILE; malformed or unreadable fails startup, unset is null. */
function secretKey(env: NodeJS.ProcessEnv): Buffer | null {
  if (env.HIVE_SECRET_KEY) return parseSecretKey(env.HIVE_SECRET_KEY);
  const file = env.HIVE_SECRET_KEY_FILE;
  if (!file) return null;
  let hex: string;
  try {
    hex = readFileSync(file, "utf8").trim();
  } catch (err) {
    throw new Error(`HIVE_SECRET_KEY_FILE can't be read: ${(err as Error).message}`);
  }
  return parseSecretKey(hex);
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
    reposRoot: env.HIVE_REPOS_ROOT || env.HIVE_REPOS_HOST_ROOT || process.cwd(),
    reposHostRoot: env.HIVE_REPOS_HOST_ROOT || env.HIVE_REPOS_ROOT || process.cwd(),
    clonesRoot: env.HIVE_CLONES_ROOT || "/data/repos",
    allowFileUrls: env.HIVE_ALLOW_FILE_URLS === "1",
    repoSyncMinutes: num(env, "HIVE_REPO_SYNC_MINUTES", 15, (n) => n >= 0),
    maxCommits: num(env, "HIVE_MAX_COMMITS", 2000, (n) => Number.isInteger(n) && n > 0),
    secretKey: secretKey(env),
    distillLeaseSeconds: num(env, "HIVE_DISTILL_LEASE_SECONDS", 600, (n) => Number.isInteger(n) && n > 0),
    webhookMaxAttempts: num(env, "HIVE_WEBHOOK_MAX_ATTEMPTS", 6, (n) => Number.isInteger(n) && n > 0),
    webhookBackoffSeconds: num(env, "HIVE_WEBHOOK_BACKOFF_SECONDS", 30, (n) => n > 0),
    staleDays: num(env, "HIVE_STALE_DAYS", 60, (n) => Number.isInteger(n) && n > 0),
    dashboardDir: resolve(env.HIVE_DASHBOARD_DIR || "/app/public"), // @fastify/static needs an absolute root
    telegramApiUrl: (env.HIVE_TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, ""),
  };
}
