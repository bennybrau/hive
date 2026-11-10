import { createHash } from "node:crypto";
import { spawnEnv } from "./env.js";
import type { Exec } from "./exec.js";
import { log as jsonLog } from "./log.js";

/**
 * Before the first `claude` call with a credential, confirm the CLI will bill it as a subscription OAuth token
 * and not something else in the environment. Checked once per distinct credential (kept only as a hash).
 */
export class ClaudeAuth {
  private ok = new Set<string>();

  constructor(
    private exec: Exec,
    private log: (msg: string) => void = jsonLog.info,
    private baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async check(credential: string): Promise<void> {
    const key = createHash("sha256").update(credential).digest("hex");
    if (this.ok.has(key)) return;
    const res = await this.exec("claude", ["auth", "status", "--json"], {
      env: spawnEnv(this.baseEnv, credential),
      timeoutMs: 30_000,
    });
    let mode = "unknown";
    let loggedIn = false;
    try {
      const status = JSON.parse(res.stdout) as { authMethod?: string; loggedIn?: boolean };
      mode = status.authMethod ?? mode;
      loggedIn = status.loggedIn === true;
    } catch {
      // not JSON: treated as unknown
    }
    if (!loggedIn || mode !== "oauth_token") throw new Error(`claude auth refused: mode=${mode} loggedIn=${loggedIn}, want oauth_token`);
    this.ok.add(key);
    this.log("auth ok mode=oauth_token");
  }
}
