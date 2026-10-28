/**
 * Remember a batch of facts through the HTTP API (same path a Hermes instance uses).
 *   HIVE_URL=http://127.0.0.1:8800 HIVE_TOKEN=hive_... pnpm --filter hive import-facts ../../scripts/seed/hive-design-facts.json
 * File: JSON array of { text, kind, scope, repo_key?, locus?, anchors? }.
 */
import { readFile } from "node:fs/promises";

const [file] = process.argv.slice(2);
const url = process.env.HIVE_URL;
const token = process.env.HIVE_TOKEN;
if (!file || !url || !token) {
  console.error("usage: HIVE_URL=... HIVE_TOKEN=... import-facts <facts.json>");
  process.exit(2);
}

const facts = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
const tally = { created: 0, deduped: 0, failed: 0 };
for (const f of facts) {
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/facts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(f),
  });
  if (res.status === 201) tally.created++;
  else if (res.status === 200) tally.deduped++;
  else {
    tally.failed++;
    console.error(`${res.status} ${await res.text()} <- ${String(f.text).slice(0, 60)}`);
  }
}
console.log(JSON.stringify(tally));
process.exitCode = tally.failed ? 1 : 0;
