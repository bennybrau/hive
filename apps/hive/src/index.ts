import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool, describeDbError } from "./db/pool.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

try {
  const applied = await migrate(pool);
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
} catch (err) {
  console.error(`hive: database not ready: ${describeDbError(err)}`);
  process.exit(1);
}

const app = buildApp(pool, { version: config.version, logger: true });
await app.listen({ host: config.host, port: config.port });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
