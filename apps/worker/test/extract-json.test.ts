import { describe, expect, it } from "vitest";
import { extractJson } from "../src/prompt.js";

describe("extractJson", () => {
  it("parses a bare object and one wrapped in prose or code fences", () => {
    expect(extractJson('{"facts":[]}')).toEqual({ facts: [] });
    expect(extractJson('Here you go:\n```json\n{"facts":[{"text":"a"}]}\n```')).toEqual({ facts: [{ text: "a" }] });
  });

  it("takes the first object when the reply holds two (a real reply that failed a job)", () => {
    expect(extractJson('{"facts":[]}\n\n{"facts":[{"text":"x"}]}')).toEqual({ facts: [] });
  });

  it("ignores braces after the object, and braces and escaped quotes inside strings", () => {
    expect(extractJson('{"facts":[{"text":"use {curly} and \\"q\\" }"}]} (note: {not json})')).toEqual({
      facts: [{ text: 'use {curly} and "q" }' }],
    });
  });

  it("skips a leading brace that isn't JSON", () => {
    expect(extractJson('Template {name} filled:\n{"facts":[]}')).toEqual({ facts: [] });
    // An opening brace that never closes doesn't stop the search.
    expect(extractJson('oops { then {"facts":[]}')).toEqual({ facts: [] });
  });

  it("doesn't end a string at an escaped quote", () => {
    expect(extractJson('{"t":"a \\" }"} {x}')).toEqual({ t: 'a " }' });
  });

  it("still fails on a reply with no JSON object", () => {
    expect(() => extractJson("I found nothing.")).toThrow(/no JSON object/);
    expect(() => extractJson("{not json} {also not}")).toThrow();
  });
});
