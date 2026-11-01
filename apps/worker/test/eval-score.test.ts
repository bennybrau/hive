import { describe, expect, it } from "vitest";
import { assign, judgePrompt, normalizeText, parseJudge, quoteValid, totals, type CaseResult } from "../src/eval/score.js";

describe("quoteValid", () => {
  it("accepts a quote that differs from the transcript only in whitespace, like the server", () => {
    expect(quoteValid("keep  the\nwatermark", "we keep the watermark in export_state")).toBe(true);
    expect(normalizeText("  a \n\t b ")).toBe("a b");
  });
  it("rejects a quote not in the transcript, and an empty one", () => {
    expect(quoteValid("billing uses Kafka", "billing retries webhooks")).toBe(false);
    expect(quoteValid("   ", "anything")).toBe(false);
  });
});

describe("assign", () => {
  const scopes = (p: string[], e: string[]) => ({ proposed: p, expected: e });

  it("credits a proposal naming an expected label, and checks its scope", () => {
    const r = assign(["E2", "E1"], 2, 0, scopes(["repo:gh/a/b", "global"], ["repo:gh/a/b", "repo:gh/a/b"]));
    expect(r.found).toEqual([true, true]);
    expect(r.verdicts[0]).toEqual({ kind: "match", label: 1, scopeOk: true });
    expect(r.verdicts[1]).toEqual({ kind: "match", label: 0, scopeOk: false });
  });

  it("credits each expected label once: a second proposal naming it is a neutral duplicate", () => {
    const r = assign(["E1", "E1"], 2, 0, scopes(["global", "global"], ["global", "global"]));
    expect(r.found).toEqual([true, false]);
    expect(r.verdicts[1]).toEqual({ kind: "acceptable", label: -1 });
  });

  it("treats an acceptable label as neutral and no label as a false positive", () => {
    const r = assign(["A1", null], 1, 1, scopes(["global", "global"], ["global"]));
    expect(r.verdicts).toEqual([{ kind: "acceptable", label: 0 }, { kind: "false_positive" }]);
    expect(r.found).toEqual([false]);
  });

  it("counts a label the case doesn't have as no match, so the judge can't invent credit", () => {
    const r = assign(["E3", "A2", "E0", "X1"], 2, 1, scopes(["global", "global", "global", "global"], ["global", "global"]));
    expect(r.verdicts.map((v) => v.kind)).toEqual(["false_positive", "false_positive", "false_positive", "false_positive"]);
    expect(r.found).toEqual([false, false]);
  });
});

describe("parseJudge", () => {
  it("maps answers by proposal number, normalising case and whitespace", () => {
    expect(parseJudge({ matches: [{ p: 2, label: " e1 " }, { p: 1, label: null }] }, 2)).toEqual([null, "E1"]);
  });
  it("leaves unanswered or out-of-range proposals unmatched", () => {
    expect(parseJudge({ matches: [{ p: 5, label: "E1" }, { p: 0, label: "E1" }] }, 2)).toEqual([null, null]);
  });
  it("rejects a reply with no matches array, so a broken judge errors instead of scoring zero", () => {
    expect(() => parseJudge({ facts: [] }, 1)).toThrow(/matches/);
  });
});

describe("judgePrompt", () => {
  it("numbers every list the way assign reads the answers", () => {
    const t = judgePrompt(["p one", "p two"], ["e one"], []);
    expect(t).toContain("P1: p one\nP2: p two");
    expect(t).toContain("E1: e one");
    expect(t).toMatch(/Acceptable labels:\n\(none\)/);
  });
});

describe("totals", () => {
  const res = (over: Partial<CaseResult>): CaseResult => ({
    id: "x", proposed: [], expected: 0, found: 0, falsePositives: 0, invalidQuotes: 0, scopeMisses: 0,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, duration_ms: 0, ...over,
  });

  it("passes exactly at the ticket's bar: 3/4 found, 1 false positive per 5 sessions, 0 bad quotes", () => {
    const t = totals([res({ expected: 4, found: 3, falsePositives: 1 }), ...Array.from({ length: 4 }, () => res({}))]);
    expect(t.recall).toBe(0.75);
    expect(t.fpPer5).toBe(1);
    expect(t.pass).toEqual({ recall: true, falsePositives: true, quotes: true });
  });

  it("fails each target just past the bar", () => {
    const t = totals([res({ expected: 4, found: 2, falsePositives: 2, invalidQuotes: 1 }), ...Array.from({ length: 4 }, () => res({}))]);
    expect(t.pass).toEqual({ recall: false, falsePositives: false, quotes: false });
  });

  it("an errored case fails recall: a run that didn't happen must not pass", () => {
    expect(totals([res({ expected: 0, error: "boom" })]).pass.recall).toBe(false);
  });
});
