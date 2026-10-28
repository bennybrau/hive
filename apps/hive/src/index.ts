import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool, describeDbError } from "./db/pool.js";
import { createEmbedder } from "./embed.js";
import { startEmbedWorker } from "./jobs/embed.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  const applied = await migrate(pool);
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
} catch (err) {
  console.error(`hive: database not ready: ${describeDbError(err)}`);
  process.exit(1);
}

const embedder = createEmbedder(config.ollamaUrl, config.embedModel);
const worker = embedder ? startEmbedWorker(pool, embedder) : null;
if (!embedder) console.log("OLLAMA_URL is empty: meaning search off, keyword search only");

const app = buildApp(pool, {
  version: config.version,
  logger: true,
  embedder,
  worker,
  minSimilarity: config.vectorMinSimilarity,
});
await app.listen({ host: config.host, port: config.port });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await worker?.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
