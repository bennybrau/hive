export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env (or run scripts/setup.sh).");
  }
  const port = Number(env.HIVE_PORT ?? 8800);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`HIVE_PORT must be a port number, got ${env.HIVE_PORT}`);
  return {
    databaseUrl,
    host: env.HIVE_HOST ?? "127.0.0.1",
    port,
    version: env.HIVE_VERSION ?? "0.0.1",
  };
}
