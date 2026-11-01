import { describe, expect, it } from "vitest";
import { HiveClient, type Claimed } from "../src/client.js";
import { MAX_FACTS, runLoop, step, type LoopDeps } from "../src/loop.js";
import type { Prompt } from "../src/prompt.js";
import type { RunResult, Runner } from "../src/runners/types.js";

const CREDENTIAL = "sk-ant-oat01-secret";
const prompt: Prompt = { version: "distill-v1", body: "scopes: {{scopes}}" };

function claimed(content = "user: let's use pnpm\nassistant: decided, pnpm it is", over: Partial<Claimed> = {}): Claimed {
  return {
    job: { id: "11111111-1111-1111-1111-111111111111", attempts: 1, lease_until: "2026-10-31T00:00:00Z" },
    episode: { id: "e1", kind: "session", repo_key: "hive", content },
    prompt_version: "distill-v1",
    credential: CREDENTIAL,
    ...over,
  };
}

/** A fake hive over fetch: one queued claim (or a status), records every request. */
function fakeHive(claim: Claimed | number, finish: { complete?: number; fail?: number } = {}) {
  const calls: { path: string; body?: any; auth?: string }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body as string) : undefined, auth: (init.headers as any).authorization });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (path.endsWith("/claim")) {
      if (typeof claim === "number") return claim === 204 ? new Response(null, { status: 204 }) : json(claim, { error: "agent credential not set" });
      return json(200, claim);
    }
    const status = path.endsWith("/complete") ? (finish.complete ?? 200) : (finish.fail ?? 200);
    return json(status, status === 409 ? { error: "job is queued, not claimed" } : {});
  }) as typeof fetch;
  return { hive: new HiveClient("http://hive:8800", "worker-token", fetchFn), calls };
}

function fakeRunner(replies: unknown[] | ((input: string) => unknown)): Runner & { inputs: string[] } {
  const inputs: string[] = [];
  return {
    model: "fake-model",
    inputs,
    async run(_p: string, input: string): Promise<RunResult> {
      inputs.push(input);
      const json = typeof replies === "function" ? replies(input) : replies[inputs.length - 1];
      if (json instanceof Error) throw json;
      return {
        json,
        usage: { model: "fake-model", input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cost_usd: 0.01, duration_ms: 1000 },
      };
    },
  };
}

const fact = (text: string, scope = "repo:hive") => ({ text, kind: "decision", scope, quote: "pnpm it is" });

function deps(hive: HiveClient, runner: Runner, extra: Partial<LoopDeps> = {}): LoopDeps & { logs: string[] } {
  const logs: string[] = [];
  return { hive, runner, prompt, log: (m) => logs.push(m), logs, ...extra };
}

describe("worker loop", () => {
  it("completes a job with the valid facts and the summed usage", async () => {
    const { hive, calls } = fakeHive(claimed());
    const d = deps(hive, fakeRunner([{ facts: [fact("We use pnpm."), fact("bad", "repo:elsewhere")] }]));
    expect(await step(d)).toBe("completed");
    expect(calls.map((c) => c.path)).toEqual(["/v1/worker/distill/claim", "/v1/worker/distill/11111111-1111-1111-1111-111111111111/complete"]);
    expect(calls.every((c) => c.auth === "Bearer worker-token")).toBe(true);
    expect(calls[1]!.body).toEqual({
      facts: [fact("We use pnpm.")],
      usage: { model: "fake-model", input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cost_usd: 0.01, duration_ms: 1000 },
    });
  });

  it("runs every chunk, sums usage, dedupes by text and caps at MAX_FACTS", async () => {
    const turns = Array.from({ length: 120 }, (_, i) => `user: q${i}\nassistant: ${"x".repeat(2000)}`);
    let call = 0;
    const runner = fakeRunner(() => {
      call++;
      return { facts: [fact("We use pnpm."), ...Array.from({ length: 5 }, (_, i) => fact(`fact ${call}-${i}`))] };
    });
    const { hive, calls } = fakeHive(claimed(turns.join("\n")));
    expect(await step(deps(hive, runner))).toBe("completed");
    expect(runner.inputs.length).toBeGreaterThan(1);
    const body = calls[1]!.body;
    expect(body.usage.input_tokens).toBe(100 * runner.inputs.length);
    expect(body.usage.cost_usd).toBeCloseTo(0.01 * runner.inputs.length);
    expect(body.facts).toHaveLength(MAX_FACTS);
    expect(body.facts.filter((f: { text: string }) => f.text === "We use pnpm.")).toHaveLength(1);
  });

  it("an empty reply completes with no facts", async () => {
    const { hive, calls } = fakeHive(claimed());
    expect(await step(deps(hive, fakeRunner([{ facts: [] }])))).toBe("completed");
    expect(calls[1]!.body.facts).toEqual([]);
  });

  it("a runner error fails the job, with the credential scrubbed", async () => {
    const { hive, calls } = fakeHive(claimed());
    const d = deps(hive, fakeRunner([new Error(`claude exited 1: bad token ${CREDENTIAL}`)]));
    expect(await step(d)).toBe("failed");
    expect(calls[1]!.path).toMatch(/\/fail$/);
    expect(calls[1]!.body.error).toBe("claude exited 1: bad token [credential]");
    expect(JSON.stringify(calls) + d.logs.join("\n")).not.toContain(CREDENTIAL);
  });

  it("a prompt_version mismatch fails the job without running anything", async () => {
    const { hive, calls } = fakeHive(claimed(undefined, { prompt_version: "distill-v2" }));
    const runner = fakeRunner([{ facts: [fact("We use pnpm.")] }]);
    expect(await step(deps(hive, runner))).toBe("failed");
    expect(runner.inputs).toEqual([]);
    expect(calls[1]!.body.error).toMatch(/hive wants distill-v2, worker has distill-v1/);
  });

  it("an auth refusal fails the job without running anything", async () => {
    const { hive, calls } = fakeHive(claimed());
    const runner = fakeRunner([{ facts: [fact("We use pnpm.")] }]);
    const auth = async () => {
      throw new Error("claude auth refused: mode=api_key loggedIn=true, want oauth_token");
    };
    expect(await step(deps(hive, runner, { auth }))).toBe("failed");
    expect(runner.inputs).toEqual([]);
    expect(calls[1]!.path).toMatch(/\/fail$/);
    expect(calls[1]!.body.error).toMatch(/mode=api_key/);
  });

  it("a 409 on complete is logged and skipped", async () => {
    const { hive, calls } = fakeHive(claimed(), { complete: 409 });
    const d = deps(hive, fakeRunner([{ facts: [] }]));
    expect(await step(d)).toBe("conflict");
    expect(calls).toHaveLength(2); // no fail after a 409
    expect(d.logs.join("\n")).toMatch(/409/);
  });

  it("a 409 on fail is logged and skipped", async () => {
    const { hive } = fakeHive(claimed(), { fail: 409 });
    expect(await step(deps(hive, fakeRunner([new Error("boom")])))).toBe("conflict");
  });

  it("a rejected complete (not 409) fails the job instead of leaving it leased", async () => {
    const { hive, calls } = fakeHive(claimed(), { complete: 400 });
    expect(await step(deps(hive, fakeRunner([{ facts: [] }])))).toBe("failed");
    expect(calls.map((c) => c.path.split("/").pop())).toEqual(["claim", "complete", "fail"]);
  });

  it("204 is idle, 503 is unavailable and backs off", async () => {
    expect(await step(deps(fakeHive(204).hive, fakeRunner([])))).toBe("idle");
    const d = deps(fakeHive(503).hive, fakeRunner([]));
    expect(await step(d)).toBe("unavailable");
    expect(d.logs).toEqual(["hive not handing out jobs: agent credential not set"]);

    const stop = new AbortController();
    const sleeps: number[] = [];
    await runLoop(d, stop.signal, async (ms) => {
      sleeps.push(ms);
      stop.abort();
    });
    expect(sleeps).toEqual([30_000]);
  });
});
