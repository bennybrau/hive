/** One JSON line per message on stdout, shaped like Fastify's (pino) lines so a log collector parses both alike. */
const LEVELS = { info: 30, warn: 40, error: 50 } as const;
export type Level = keyof typeof LEVELS;

export function logLine(level: Level, msg: string, time = Date.now()): string {
  return JSON.stringify({ level: LEVELS[level], time, msg });
}

function write(level: Level) {
  return (msg: string) => void process.stdout.write(logLine(level, msg) + "\n");
}

export const log = { info: write("info"), warn: write("warn"), error: write("error") };
