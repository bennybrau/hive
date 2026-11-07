import { describe, expect, it } from "vitest";
import { userTurns } from "../src/distill.js";

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

  it("text before the first user: line, or a line merely containing user:, starts no turn", () => {
    expect(userTurns("assistant: hi\nthe user: said\nusers: no")).toEqual([]);
    expect(userTurns("")).toEqual([]);
  });
});
