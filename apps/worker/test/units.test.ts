import { describe, expect, it } from "vitest";
import { ClaudeAuth } from "../src/auth.js";
import { chunkTranscript, splitTurns } from "../src/chunk.js";
import { spawnEnv } from "../src/env.js";
import type { Exec, ExecOptions } from "../src/exec.js";
import { allowedScopes, loadPrompt, parseFacts, PROMPT_PATH, renderPrompt } from "../src/prompt.js";
import { ClaudeRunner, parseEnvelope } from "../src/runners/claude.js";

describe("spawnEnv", () => {
  it("strips every billing variable and sets only the OAuth token", () => {
    const env = spawnEnv(
      {
        PATH: "/bin",
        HOME: "/home/node",
        ANTHROPIC_API_KEY: "sk-ant-api",
        ANTHROPIC_AUTH_TOKEN: "bearer",
        CLAUDE_CODE_OAUTH_TOKEN: "someone-elses",
        ANTHROPIC_BASE_URL: "http://proxy",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
      },
      "sk-ant-oat-mine",
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/node", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-mine" });
  });

  it("does not modify the base environment", () => {
    const base = { ANTHROPIC_API_KEY: "x" };
    spawnEnv(base, "t");
    expect(base).toEqual({ ANTHROPIC_API_KEY: "x" });
  });
});

describe("chunkTranscript", () => {
  const turn = (n: number, size: number) => `user: q${n}\nassistant: ${"a".repeat(size)}`;

  it("splits at user: lines; a preamble and multi-line turns stay together", () => {
    const text = "tool(x): preamble\nuser: one\nmore of one\nassistant: reply\nuser: two\nassistant -> f()\nassistant: ok";
    expect(splitTurns(text)).toEqual(["tool(x): preamble", "user: one\nmore of one\nassistant: reply", "user: two\nassistant -> f()\nassistant: ok"]);
  });

  it("a short transcript is one chunk, verbatim", () => {
    const text = [turn(1, 10), turn(2, 10)].join("\n");
    expect(chunkTranscript(text, 1000)).toEqual([text]);
    expect(chunkTranscript("  \n", 1000)).toEqual([]);
  });

  it("cuts between turns under the limit, each chunk repeating the previous turn", () => {
    const turns = [1, 2, 3, 4, 5].map((n) => turn(n, 80)); // ~100 chars each
    const chunks = chunkTranscript(turns.join("\n"), 250);
    expect(chunks).toEqual([turns.slice(0, 2).join("\n"), turns.slice(1, 3).join("\n"), turns.slice(2, 4).join("\n"), turns.slice(3, 5).join("\n")]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(250);
  });

  it("hard-cuts a single turn longer than the limit", () => {
    const big = turn(1, 500);
    const chunks = chunkTranscript(big, 200);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join("")).toBe(big); // pieces too big to overlap: no repeats
  });
});

describe("claude envelope", () => {
  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 4321,
    result: '```json\n{"facts":[]}\n```',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 2000, output_tokens: 30 },
  };

  it("takes tokens, cost and duration from the envelope", () => {
    expect(parseEnvelope(JSON.stringify(envelope), "claude-sonnet-5-5")).toEqual({
      text: envelope.result,
      usage: { model: "claude-sonnet-5-5", input_tokens: 150, output_tokens: 30, cache_read_tokens: 2000, cost_usd: 0.0123, duration_ms: 4321 },
    });
  });

  it("an error envelope throws", () => {
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, subtype: "error_max_turns", is_error: true }), "m")).toThrow(/error_max_turns/);
    expect(() => parseEnvelope("not json", "m")).toThrow(/not a JSON envelope/);
  });

  it("runs claude -p one turn with the prompt on stdin and the stripped env", async () => {
    let seen: { cmd: string; args: string[]; opts?: ExecOptions } | undefined;
    const exec: Exec = async (cmd, args, opts) => {
      seen = { cmd, args, opts };
      return { code: 0, stdout: JSON.stringify(envelope), stderr: "" };
    };
    const runner = new ClaudeRunner(exec, "claude-sonnet-5-5", { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-api" });
    const res = await runner.run("PROMPT", "user: hi", "oat");
    expect(res.json).toEqual({ facts: [] });
    expect(seen!.cmd).toBe("claude");
    expect(seen!.args).toEqual(["-p", "--output-format", "json", "--max-turns", "1", "--model", "claude-sonnet-5-5"]);
    expect(seen!.opts!.input).toBe("PROMPT\nuser: hi\n");
    expect(seen!.opts!.env).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oat" });
  });
});

describe("ClaudeAuth", () => {
  const statusExec =
    (status: object, calls: string[]): Exec =>
    async (_cmd, args, opts) => {
      calls.push(`${args.join(" ")} ${opts?.env?.CLAUDE_CODE_OAUTH_TOKEN}`);
      return { code: 0, stdout: JSON.stringify(status), stderr: "" };
    };

  it("accepts an oauth_token login once per credential", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const auth = new ClaudeAuth(statusExec({ loggedIn: true, authMethod: "oauth_token" }, calls), (m) => logs.push(m), {});
    await auth.check("a");
    await auth.check("a");
    await auth.check("b");
    expect(calls).toEqual(["auth status --json a", "auth status --json b"]);
    expect(logs).toEqual(["auth ok mode=oauth_token", "auth ok mode=oauth_token"]);
  });

  it("refuses any other auth mode, and checks again next time", async () => {
    const calls: string[] = [];
    const auth = new ClaudeAuth(statusExec({ loggedIn: true, authMethod: "api_key" }, calls), () => {}, {});
    await expect(auth.check("a")).rejects.toThrow(/mode=api_key/);
    await expect(auth.check("a")).rejects.toThrow(/want oauth_token/);
    expect(calls).toHaveLength(2);
  });

  it("refuses a logged-out or unparseable status", async () => {
    await expect(new ClaudeAuth(statusExec({ loggedIn: false, authMethod: "oauth_token" }, []), () => {}, {}).check("a")).rejects.toThrow(/loggedIn=false/);
    const garbage: Exec = async () => ({ code: 1, stdout: "Not logged in", stderr: "" });
    await expect(new ClaudeAuth(garbage, () => {}, {}).check("a")).rejects.toThrow(/mode=unknown/);
  });
});

describe("prompt", () => {
  it("the prompt file carries its version", () => {
    expect(loadPrompt(PROMPT_PATH).version).toBe("distill-v5");
    expect(loadPrompt(PROMPT_PATH).body).toContain('{"facts":[]}');
  });

  it("renderPrompt describes the source and where quotes come from per episode kind", () => {
    const prompt = loadPrompt(PROMPT_PATH);
    const session = renderPrompt(prompt, "gh/o/r", "session");
    const run = renderPrompt(prompt, "gh/o/r", "asf_run");
    for (const out of [session, run]) {
      expect(out).not.toMatch(/\{\{\w+\}\}/);
      expect(out).toContain('"repo:gh/o/r" by default');
    }
    expect(session).toContain("conversation between a developer (user) and their coding agent");
    expect(session).toContain("from a line that starts with `user:` only");
    expect(session).not.toContain("software-factory run");
    expect(run).toContain("the approved plan for a change, then the review of the finished work");
    expect(run).toContain("Never turn a plan step");
    expect(run).toContain("from any line");
    expect(run).not.toContain("starts with `user:`");
    expect(renderPrompt(prompt, null, "turn")).toBe(renderPrompt(prompt, null, "session"));
  });

  it("renderPrompt reads an asf_dialog as a person's note to the factory, quoted from the user line only", () => {
    const dialog = renderPrompt(loadPrompt(PROMPT_PATH), "gh/o/r", "asf_dialog");
    expect(dialog).not.toMatch(/\{\{\w+\}\}/);
    expect(dialog).toContain("a person's note to a software factory, after the factory's text");
    expect(dialog).toContain("from a line that starts with `user:` only. Never quote the assistant's text");
    expect(dialog).not.toContain("coding agent");
    expect(dialog).not.toContain("from any line");
  });

  it("renderPrompt fills {{remember}} only on a remember job, and offers its personal scope", () => {
    const prompt = loadPrompt(PROMPT_PATH);
    const normal = renderPrompt(prompt, "gh/o/r", "turn");
    const remember = renderPrompt(prompt, "gh/o/r", "turn", { personalScope: "personal:alice" });
    for (const out of [normal, remember]) expect(out).not.toMatch(/\{\{\w+\}\}/);
    expect(normal).not.toContain("This turn was flagged");
    expect(normal).not.toContain("personal:");
    expect(remember).toContain("This turn was flagged: the user asked for something in it to be remembered.");
    expect(remember).toContain('"personal:alice" for a note');
    const noUser = renderPrompt(prompt, null, "turn", { personalScope: null });
    expect(noUser).toContain("This turn was flagged");
    expect(noUser).not.toContain("personal:");
  });

  it("allowedScopes adds the personal scope when the claim offers one", () => {
    expect(allowedScopes("gh/o/r")).toEqual(["global", "repo:gh/o/r"]);
    expect(allowedScopes("gh/o/r", null)).toEqual(["global", "repo:gh/o/r"]);
    expect(allowedScopes("gh/o/r", "personal:alice")).toEqual(["global", "repo:gh/o/r", "personal:alice"]);
    expect(allowedScopes(null, "personal:alice")).toEqual(["global", "personal:alice"]);
  });

  it("parseFacts keeps valid facts and drops malformed or out-of-scope ones", () => {
    const ok = { text: "We use pnpm, not npm.", kind: "convention", scope: "repo:hive", quote: "use pnpm" };
    const facts = parseFacts(
      {
        facts: [
          ok,
          { ...ok, kind: "opinion" },
          { ...ok, scope: "repo:other" },
          { ...ok, quote: "" },
          { ...ok, text: "x" },
          null,
          { ...ok, locus: ["a.ts", 3, ""] },
        ],
      },
      ["global", "repo:hive"],
    );
    expect(facts).toEqual([ok, { ...ok, locus: ["a.ts"] }]);
    expect(() => parseFacts({ nope: 1 }, ["global"])).toThrow(/facts/);
  });
});
