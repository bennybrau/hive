import { spawn } from "node:child_process";

export interface ExecOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command to completion. Injected everywhere a child process is spawned so tests can fake it. */
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {}); // the child may exit before reading all of stdin
    child.stdin.end(opts.input ?? "");
  });
