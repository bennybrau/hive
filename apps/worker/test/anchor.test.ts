import { describe, expect, it } from "vitest";
import { HiveClient, type Claimed } from "../src/client.js";
import { step } from "../src/loop.js";
import { anchorQuote } from "../src/prompt.js";

// A tool-call line as the plugin renders it: the arguments are JSON, so newlines and quotes are escaped.
const CHUNK = [
  "user: why does hive_review say Unknown tool?",
  'assistant -> write_file({"content": "Hermes builds a memory provider\'s tool routing table in\\n`MemoryManager.add_provider()`, before \\"initialize\\""})',
  "assistant: Found it: the routing table is built before initialize(), so the tool is never routed.",
].join("\n");

describe("anchorQuote", () => {
  it("keeps a quote that is already verbatim, whitespace aside", () => {
    expect(anchorQuote("the routing table is built  before initialize()", CHUNK)).toBe("the routing table is built  before initialize()");
  });

  it("doesn't escape a verbatim quote that holds characters JSON would escape", () => {
    expect(anchorQuote('say "ship it"', 'user: just say "ship it" and go')).toBe('say "ship it"');
  });

  it("re-escapes a quote taken from tool-call arguments with the escapes undone", () => {
    const q = anchorQuote("routing table in\n`MemoryManager.add_provider()`, before \"initialize\"", CHUNK);
    expect(q).toBe('routing table in\\n`MemoryManager.add_provider()`, before \\"initialize\\"');
    expect(CHUNK.includes(q!)).toBe(true);
  });

  it("falls back to the longest verbatim piece of a quote joined with an ellipsis", () => {
    expect(anchorQuote("Found it: the routing table is built... so the tool is never routed.", CHUNK)).toBe("Found it: the routing table is built");
    expect(anchorQuote("why does hive_review say Unknown tool? … no", CHUNK)).toBe("why does hive_review say Unknown tool?");
  });

  it("matches an escaped newline in tool-call arguments that the model turned into a space", () => {
    // From a real run: the transcript has `in\n`MemoryManager` (escaped), the model quoted `in `MemoryManager`.
    expect(anchorQuote("Hermes builds a memory provider's tool routing table in `MemoryManager.add_", CHUNK)).toBe(
      "Hermes builds a memory provider's tool routing table in\\n`MemoryManager.add_",
    );
  });

  it("anchors a quote with reworded edges to its longest verbatim run of at least 6 words and half the quote", () => {
    // From a real run: the model rewrote the first words; the rest is verbatim.
    const chunk = 'assistant: Registry only says "database unreachable" and drops the Postgres error. It should log more.';
    expect(anchorQuote('The registry logs only "database unreachable" and drops the Postgres error.', chunk)).toBe(
      '"database unreachable" and drops the Postgres error.',
    );
    // 5 matching words of 9 is under the 6-word floor: no anchor rather than a stray fragment.
    expect(anchorQuote("totally different words then and drops the Postgres error.", chunk)).toBeNull();
    // 7 verbatim words of a 15-word quote clears the 6-word floor but not half the quote.
    expect(anchorQuote('so the registry, which crash-loops for minutes, reports "database unreachable" and drops the Postgres error.', chunk)).toBeNull();
  });

  it("returns null for a paraphrase, or pieces too short to anchor anything", () => {
    expect(anchorQuote("the tool table is made before init", CHUNK)).toBeNull();
    expect(anchorQuote("Found it... never routed", CHUNK)).toBeNull();
    expect(anchorQuote("   ", CHUNK)).toBeNull();
  });
});

describe("worker loop quote repair", () => {
  it("submits the repaired quote, so the hive keeps the fact", async () => {
    const bodies: any[] = [];
    const claim: Claimed = {
      job: { id: "11111111-1111-1111-1111-111111111111", attempts: 1, lease_until: "2026-10-31T00:00:00Z" },
      episode: { id: "e1", kind: "session", repo_key: "hive", content: CHUNK },
      prompt_version: "distill-v2",
      credential: "cred",
    };
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (init.body) bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify(new URL(url).pathname.endsWith("/claim") ? claim : {}), { status: 200 });
    }) as typeof fetch;
    const runner = {
      model: "m",
      async run() {
        return {
          json: { facts: [{ text: "Hermes routes tools before initialize().", kind: "gotcha", scope: "repo:hive", quote: "routing table in\n`MemoryManager.add_provider()`" }] },
          usage: { model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0, duration_ms: 1 },
        };
      },
    };
    expect(await step({ hive: new HiveClient("http://hive:8800", "t", fetchFn), runner, prompt: { version: "distill-v2", body: "{{scopes}}" }, log: () => {} })).toBe("completed");
    expect(bodies.at(-1).facts[0].quote).toBe("routing table in\\n`MemoryManager.add_provider()`");
  });
});
