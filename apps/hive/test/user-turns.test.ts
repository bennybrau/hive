import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { distillView, exchangeFor, isPlainQuestion, questionsOnly, userTurns } from "../src/distill.js";
import { normalizeText } from "../src/facts.js";

describe("userTurns", () => {
  it("keeps a multi-line user turn whole, up to the next user: line", () => {
    expect(userTurns("user: first line\n  second line\n\nthird\nuser: next")).toEqual(["user: first line\n  second line\n\nthird", "user: next"]);
  });

  it("an assistant:, assistant -> or tool( line ends the turn, and what follows it is not a user turn", () => {
    const content = [
      "user: one",
      "assistant: reply",
      "more reply",
      "user: two",
      "assistant -> terminal({})",
      "user: three",
      "  three, continued",
      "tool(terminal): {}",
      "tool output",
    ].join("\n");
    expect(userTurns(content)).toEqual(["user: one", "user: two", "user: three\n  three, continued"]);
  });

  it("each user_response on a tool(clarify) line is a turn, kept escaped; it also ends an open turn", () => {
    const clarify =
      'tool(clarify): {"responses": [{"question": "Which cache?", "user_response": "Postgres, \\"always\\""}, {"question": "Retries?", "user_response": "three"}]}';
    expect(userTurns(`user: plan it\n${clarify}\nmore`)).toEqual(["user: plan it", 'Postgres, \\"always\\"', "three"]);
  });

  it("reads the answers on a clipped clarify line, and none from other tool( lines", () => {
    const clipped = 'tool(clarify): {"responses": [{"question": "Q", "user_response": "keep it"}, {"question": "R", "user_resp …[90 chars clipped]';
    expect(userTurns(clipped)).toEqual(["keep it"]);
    expect(userTurns('tool(terminal): {"user_response": "nope"}\nassistant -> clarify({"user_response": "no"})')).toEqual([]);
  });

  it("text before the first user: line, or a line merely containing user:, starts no turn", () => {
    expect(userTurns("assistant: hi\nthe user: said\nusers: no")).toEqual([]);
    expect(userTurns("")).toEqual([]);
  });
});

describe("exchangeFor", () => {
  const content = [
    "assistant: hello",
    "user: first ask",
    "assistant: I propose Redis",
    "  for the cache",
    "assistant -> terminal({})",
    "tool(terminal): ok",
    "assistant: or memcached",
    "user: no, we use   Postgres",
    "  for everything",
    "assistant: noted",
  ].join("\n");

  it("returns the matching user turn and the assistant text turns since the previous user turn", () => {
    expect(exchangeFor(content, "we use Postgres for everything")).toEqual({
      assistant: "I propose Redis\n  for the cache\nor memcached",
      user: "no, we use   Postgres\n  for everything",
    });
  });

  it("assistant is null when no assistant text comes before the user turn", () => {
    expect(exchangeFor("user: we deploy on Fridays\nassistant: ok", "deploy on Fridays")).toEqual({ assistant: null, user: "we deploy on Fridays" });
    expect(exchangeFor("user: a\nassistant -> t({})\nuser: b", "b")).toEqual({ assistant: null, user: "b" });
  });

  it("is null when the quote is only in an assistant turn, nowhere, or empty", () => {
    expect(exchangeFor(content, "I propose Redis")).toBeNull();
    expect(exchangeFor(content, "kafka")).toBeNull();
    expect(exchangeFor(content, "  ")).toBeNull();
  });

  it("a clarify answer's exchange is its question and the answer; text only in a question is not a user turn", () => {
    const line =
      'tool(clarify): {"responses": [{"question": "Which cache?", "user_response": "Redis"}, {"question": "Use \\"Kafka\\"?", "user_response": "No, \\"Postgres\\" queues"}]}';
    const c = `user: plan it\nassistant: some questions\n${line}\nassistant: ok`;
    expect(exchangeFor(c, 'No, \\"Postgres\\" queues')).toEqual({ assistant: 'Use "Kafka"?', user: 'No, "Postgres" queues' });
    expect(exchangeFor(c, "Which cache?")).toBeNull();
    const clipped = 'tool(clarify): {"responses": [{"question": "Which cache?", "user_response": "Redis"}, {"quest …[9 chars clipped]';
    expect(exchangeFor(clipped, "Redis")).toEqual({ assistant: null, user: "Redis" });
  });

  it("a skipped clarify question (user_response: null) doesn't shift the pairing of later answers", () => {
    const skippedFirst =
      'tool(clarify): {"responses": [{"question": "First?", "user_response": null}, {"question": "Second?", "user_response": "Use Postgres"}]}';
    expect(exchangeFor(skippedFirst, "Use Postgres")).toEqual({ assistant: "Second?", user: "Use Postgres" });
    const skippedMiddle =
      'tool(clarify): {"responses": [{"question": "A?", "user_response": "alpha"}, {"question": "B?", "user_response": null}, {"question": "C?", "user_response": "gamma"}]}';
    expect(exchangeFor(skippedMiddle, "alpha")).toEqual({ assistant: "A?", user: "alpha" });
    expect(exchangeFor(skippedMiddle, "gamma")).toEqual({ assistant: "C?", user: "gamma" });
  });

  it("keeps the last 600 chars of the assistant text", () => {
    const reply = "a".repeat(400) + "b".repeat(600);
    expect(exchangeFor(`assistant: ${reply}\nuser: ok then`, "ok then")?.assistant).toBe("b".repeat(600));
  });
});

describe("isPlainQuestion / questionsOnly", () => {
  it("a user turn ending in ? (after trimming) is a plain question", () => {
    expect(isPlainQuestion("user: how do we deploy?")).toBe(true);
    expect(isPlainQuestion("user:   where do logs go?  \n")).toBe(true);
    expect(isPlainQuestion("user: we deploy on Fridays.")).toBe(false);
    expect(isPlainQuestion("user: is it Friday? We deploy then")).toBe(false);
  });

  const markers = [
    "instead", "actually", "rather", "don't", "do not", "never", "always", "from now on", "let's", "should be", "must",
    "i want", "i'd like", "please", "remember", "no,", "not ",
  ];
  for (const m of markers) {
    it(`a question with "${m}" is not plain, in any case`, () => {
      expect(isPlainQuestion(`user: is it ${m}?`)).toBe(false);
      expect(isPlainQuestion(`user: is it ${m.toUpperCase()}?`)).toBe(false);
    });
  }

  it("a curly apostrophe counts as a straight one", () => {
    expect(isPlainQuestion("user: why don\u2019t we cache it?")).toBe(false);
  });

  it("a clarify answer (no user: prefix) is never a plain question", () => {
    expect(isPlainQuestion("Friday?")).toBe(false);
  });

  it("questionsOnly: every user turn (clarify answers included) is a plain question, or there are none", () => {
    expect(questionsOnly("user: how?\nassistant: like this\ntool(terminal): we must\nuser: and why?")).toBe(true);
    expect(questionsOnly("assistant: hello")).toBe(true);
    expect(questionsOnly("user: how?\nuser: use Postgres.")).toBe(false);
    expect(questionsOnly('user: how?\ntool(clarify): {"responses": [{"question": "Q", "user_response": "Redis?"}]}')).toBe(false);
  });
});

describe("distillView", () => {
  it("keeps user turns, clarify lines and the last assistant text before each; drops tool calls and output with a … line", () => {
    const clarify = 'tool(clarify): {"responses": [{"question": "Which cache?", "user_response": "Postgres"}]}';
    const content = [
      "preamble",
      "user: plan it",
      "  over two lines",
      "assistant: first thoughts",
      "assistant -> terminal({})",
      "tool(terminal): {\"output\": \"secret file\"}",
      "more output",
      "assistant: some questions",
      "  continued",
      clarify,
      "user: go",
      "assistant: done",
    ].join("\n");
    expect(distillView(content)).toBe(
      ["…", "user: plan it", "  over two lines", "…", "assistant: some questions", "  continued", clarify, "user: go", "…"].join("\n"),
    );
  });

  it("is the content itself when nothing is dropped", () => {
    const content = "assistant: a plan\nuser: ship it\nassistant: ok\nuser: thanks";
    expect(distillView(content)).toBe(content);
  });

  it("an assistant text already before a kept user turn isn't reused for the next one", () => {
    expect(distillView("assistant: a\nuser: b\nuser: c")).toBe("assistant: a\nuser: b\nuser: c");
    expect(distillView("assistant: a\nuser: b\nassistant -> t({})\nuser: c")).toBe("assistant: a\nuser: b\n…\nuser: c");
  });

  it("clips the assistant text to its last 2,000 chars, marked […]", () => {
    const reply = "a".repeat(10) + "b".repeat(2000);
    expect(distillView(`assistant: ${reply}\nuser: ok`)).toBe(`assistant: […]${"b".repeat(2000)}\nuser: ok`);
    const fits = "c".repeat(2000);
    expect(distillView(`assistant: ${fits}\nuser: ok`)).toBe(`assistant: ${fits}\nuser: ok`);
  });
});

// distill-v5 must quote a user turn, so every label's evidence must be in the full episode and in what is sent.
describe("eval-distill cases through the distill view", () => {
  const dir = fileURLToPath(new URL("../../../scripts/eval-distill/cases/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  it("has cases", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as { expected: { evidence?: string }[] };
    const transcript = readFileSync(join(dir, f.replace(/\.json$/, ".txt")), "utf8");
    meta.expected.forEach((l, i) => {
      it(`${f} E${i + 1}: evidence is in a user turn of the episode and of the view`, () => {
        const q = normalizeText(l.evidence ?? "");
        expect(q).not.toBe("");
        expect(userTurns(transcript).some((t) => normalizeText(t).includes(q))).toBe(true);
        expect(userTurns(distillView(transcript)).some((t) => normalizeText(t).includes(q))).toBe(true);
      });
    });
  }
});
