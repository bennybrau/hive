import { describe, expect, it, vi } from "vitest";
import { log, logLine } from "../src/log.js";

describe("logLine", () => {
  it("is one pino-shaped JSON line", () => {
    const line = logLine("warn", 'embed worker: "down"\nretrying', 1700000000000);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ level: 40, time: 1700000000000, msg: 'embed worker: "down"\nretrying' });
  });
});

describe("log", () => {
  it.each(["info", "warn", "error"] as const)("%s writes one newline-terminated JSON line to stdout", (level) => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log[level]("hello");
    expect(write).toHaveBeenCalledOnce();
    const out = String(write.mock.calls[0]?.[0]);
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toMatchObject({ msg: "hello" });
    write.mockRestore();
  });
});
