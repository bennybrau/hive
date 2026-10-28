/**
 * Mint an instance token. Prints the token ONCE; only its hash is stored.
 *   node dist/cli/mint-token.js --name jon-macbook --user jon [--role curator]
 */
import { parseArgs } from "node:util";
import { createInstance, type Role } from "../auth.js";
import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { createPool, describeDbError } from "../db/pool.js";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    user: { type: "string" },
    role: { type: "string", default: "member" },
    json: { type: "boolean", default: false },
  },
});

if (!values.name || !values.user) {
  console.error("usage: mint-token --name <instance-name> --user <user-id> [--role member|curator] [--json]");
  process.exit(2);
}
if (values.role !== "member" && values.role !== "curator") {
  console.error(`--role must be member or curator, got ${values.role}`);
  process.exit(2);
}

const pool = createPool(loadConfig().databaseUrl);
try {
  await migrate(pool);
  const { instance, token } = await createInstance(pool, {
    name: values.name,
    userId: values.user,
    role: values.role as Role,
  });
  if (values.json) console.log(JSON.stringify({ ...instance, token }));
  else console.log(`instance ${instance.name} (user ${instance.user_id}, ${instance.role})\nHIVE_TOKEN=${token}`);
} catch (err) {
  const msg = describeDbError(err);
  console.error(msg.includes("instances_name_key") ? `an instance named ${values.name} already exists` : `mint-token failed: ${msg}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
