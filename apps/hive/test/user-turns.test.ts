import { describe, expect, it } from "vitest";
import { exchangeFor, userTurns } from "../src/distill.js";

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
