import { describe, expect, it } from "vitest";
import { HiveClient } from "../src/client.js";
import type { Exec } from "../src/exec.js";
import { HermesRunner } from "../src/runners/hermes.js";
import { OllamaRunner } from "../src/runners/ollama.js";
import { cost, count } from "../src/runners/types.js";

describe("count/cost", () => {
  it("accepts positive finite numbers, else 0", () => {
    expect(count(5.7)).toBe(6);
    expect(count(0)).toBe(0);
    expect(count(-1)).toBe(0);
    expect(count(NaN)).toBe(0);
    expect(count(undefined)).toBe(0);
    expect(count("5")).toBe(0);
  });

  it("cost keeps fractional positive numbers, else 0", () => {
    expect(cost(0.0123)).toBe(0.0123);
    expect(cost(0)).toBe(0);
    expect(cost(-1)).toBe(0);
    expect(cost(undefined)).toBe(0);
  });
});

describe("OllamaRunner", () => {
  it("posts /api/chat in JSON mode and reads usage from the body", async () => {
    let seen: { url: string; body: any } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(init.body as string) };
      return new Response(
        JSON.stringify({ message: { content: '```json\n{"facts":[]}\n```' }, prompt_eval_count: 40, eval_count: 8 }),
        { status: 200 },
      );
    }) as typeof fetch;
    const runner = new OllamaRunner("http://ollama:11434", "llama3.1", fetchFn);
    const res = await runner.run("PROMPT", "user: hi");
    expect(seen!.url).toBe("http://ollama:11434/api/chat");
    expect(seen!.body).toEqual({
      model: "llama3.1",
      format: "json",
      stream: false,
      messages: [
        { role: "system", content: "PROMPT" },
        { role: "user", content: "user: hi" },
      ],
    });
    expect(res.json).toEqual({ facts: [] });
    expect(res.usage).toMatchObject({ model: "llama3.1", input_tokens: 40, output_tokens: 8, cache_read_tokens: 0, cost_usd: 0 });
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const runner = new OllamaRunner("http://ollama:11434", "llama3.1", fetchFn);
    await expect(runner.run("p", "i")).rejects.toThrow(/ollama \/api\/chat 500/);
  });
});

describe("HermesRunner", () => {
  it("runs hermes -z with a usage file and reads model/usage/cost from it", async () => {
    let seen: { cmd: string; args: string[] } | undefined;
    const exec: Exec = async (cmd, args, opts) => {
      seen = { cmd, args };
      const usageFile = args[args.indexOf("--usage-file") + 1]!;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(usageFile, JSON.stringify({ model: "hermes-7b", input_tokens: 12, output_tokens: 3, cache_read_tokens: 1, estimated_cost_usd: 0.002 }));
      return { code: 0, stdout: '{"facts":[]}', stderr: "" };
    };
    const runner = new HermesRunner(exec, "hermes");
    const res = await runner.run("PROMPT", "user: hi");
    expect(seen!.cmd).toBe("hermes");
    expect(seen!.args[0]).toBe("-z");
    expect(seen!.args[1]).toBe("PROMPT\nuser: hi\n");
    expect(res.json).toEqual({ facts: [] });
    expect(res.usage).toMatchObject({ model: "hermes-7b", input_tokens: 12, output_tokens: 3, cache_read_tokens: 1, cost_usd: 0.002 });
  });

  it("throws on a non-zero exit, without reading a usage file", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "model not found" });
    const runner = new HermesRunner(exec, "hermes");
    await expect(runner.run("p", "i")).rejects.toThrow(/hermes exited 1: model not found/);
  });
});

describe("HiveClient", () => {
  it("throws with the hive's error message on an unexpected claim status", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: "db down" }), { status: 500 })) as typeof fetch;
    const hive = new HiveClient("http://hive:8800", "tok", fetchFn);
    await expect(hive.claim()).rejects.toThrow(/claim: 500 db down/);
  });

  it("falls back to the raw body when the error isn't JSON", async () => {
    const fetchFn = (async () => new Response("plain text failure", { status: 502 })) as typeof fetch;
    const hive = new HiveClient("http://hive:8800", "tok", fetchFn);
    await expect(hive.claim()).rejects.toThrow(/claim: 502 plain text failure/);
  });

  it("throws on an unexpected complete status, with the hive's error", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })) as typeof fetch;
    const hive = new HiveClient("http://hive:8800", "tok", fetchFn);
    await expect(hive.complete("id1", { facts: [], usage: { model: "m", input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0 } })).rejects.toThrow(
      /complete: 404 not found/,
    );
  });
});
