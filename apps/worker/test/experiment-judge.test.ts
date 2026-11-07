import { describe, expect, it } from "vitest";
import { judge, judgePrompt, noteLine, parseVerdict, type Question } from "../src/experiment/judge.js";
import type { Runner } from "../src/runners/types.js";

const q: Question = { id: "who-1", question: "Which service talks to Postgres?", key: ["Only the registry.", "The api and worker go through it."], where: "code" };
const none: Question = { id: "none-2", question: "Where is ASF's Helm chart?", key: ["There is none."], where: "none" };

describe("judgePrompt", () => {
  it("numbers the key points, quotes the answer and never names the arm", () => {
    const p = judgePrompt(q, "  The registry owns the DB.\n");
    expect(p).toContain("K1: Only the registry.\nK2: The api and worker go through it.");
    expect(p).toContain("<answer>\nThe registry owns the DB.\n</answer>");
    expect(p).not.toMatch(/\b(arm|hive|off|on)\b/i);
  });
  it("tells the judge that a 'none' question's thing doesn't exist, and only then", () => {
    expect(judgePrompt(none, "x")).toContain("does not exist");
    expect(judgePrompt(q, "x")).not.toContain("does not exist");
  });
  it("marks an empty answer", () => {
    expect(judgePrompt(q, " \n")).toContain("<answer>\n(empty)\n</answer>");
  });
});

describe("parseVerdict", () => {
  it("is correct when every point is present and nothing contradicts", () => {
    const v = parseVerdict({ points: [{ k: 1, present: true }, { k: 2, present: true }], contradictions: [], notes: "ok" }, 2);
    expect(v).toEqual({ correct: true, points: [true, true], contradictions: [], notes: "ok" });
  });
  it("is incorrect when a point is missing, absent from the reply, or out of range", () => {
    expect(parseVerdict({ points: [{ k: 1, present: true }, { k: 2, present: false }], contradictions: [] }, 2).correct).toBe(false);
    expect(parseVerdict({ points: [{ k: 1, present: true }], contradictions: [] }, 2).correct).toBe(false);
    expect(parseVerdict({ points: [{ k: 1, present: true }, { k: 3, present: true }], contradictions: [] }, 2).points).toEqual([true, false]);
    expect(parseVerdict({ points: [{ k: 1, present: "yes" }], contradictions: [] }, 1).correct).toBe(false);
  });
  it("is incorrect when the answer contradicts the key, even with every point present", () => {
    const v = parseVerdict({ points: [{ k: 1, present: true }], contradictions: ["says there is a chart in deploy/helm"], notes: "" }, 1);
    expect(v.correct).toBe(false);
    expect(v.contradictions).toEqual(["says there is a chart in deploy/helm"]);
  });
  it("ignores blank contradictions", () => {
    expect(parseVerdict({ points: [{ k: 1, present: true }], contradictions: ["", "  ", 3] }, 1).correct).toBe(true);
  });
  it("treats a malformed reply as incorrect", () => {
    for (const bad of [null, "yes", {}, { points: "all" , contradictions: [] }, { points: [{ k: 1, present: true }] }]) {
      const v = parseVerdict(bad, 1);
      expect(v.correct).toBe(false);
      expect(v.notes).toMatch(/^malformed judge reply/);
    }
  });
});

describe("noteLine", () => {
  it("joins the notes, missing points and contradictions", () => {
    expect(noteLine({ correct: false, points: [true, false], contradictions: ["says the api"], notes: "close" })).toBe("close | missing K2 | contradicts: says the api");
    expect(noteLine({ correct: true, points: [true], contradictions: [], notes: "" })).toBe("");
  });
});

describe("judge", () => {
  const usage = { model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0.01, duration_ms: 1 };
  it("returns the verdict and the judge's own cost", async () => {
    const runner: Runner = { model: "m", run: async () => ({ json: { points: [{ k: 1, present: true }], contradictions: [] }, usage }) };
    expect(await judge(runner, none, "There is no Helm chart.", "tok")).toMatchObject({ correct: true, judge_cost_usd: 0.01 });
  });
  it("counts a failed judge call (e.g. a reply with no JSON) as incorrect, without the credential", async () => {
    const runner: Runner = { model: "m", run: async () => { throw new Error("no JSON object in reply from tok-secret"); } };
    const v = await judge(runner, q, "x", "tok-secret");
    expect(v).toMatchObject({ correct: false, points: [false, false], judge_cost_usd: 0 });
    expect(v.notes).toContain("[credential]");
    expect(v.notes).not.toContain("tok-secret");
  });
});
