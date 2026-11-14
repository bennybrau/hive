import { describe, expect, it } from "vitest";
import { JOB, KIND, ORIGIN, RAW_VALUES, ROLE, STATUS, VERIFY, WHERE, levelLabel, usedTimes, when, word } from "./words";

const NOW = Date.parse("2026-11-12T18:00:00Z");
const ago = (secs: number) => new Date(NOW - secs * 1000).toISOString();

describe("words", () => {
  it("has a plain word for every status, origin, kind and verify state the API sends", () => {
    for (const s of ["candidate", "active", "superseded", "retracted"]) expect(STATUS[s]!.label).not.toBe(s);
    for (const o of ["authored", "distilled", "ingested"]) expect(ORIGIN[o]!.label).not.toBe(o);
    for (const k of ["decision", "preference", "convention", "invariant", "gotcha", "system"]) expect(KIND[k]!.label).toBeTruthy();
    for (const v of ["verified", "drifted", "missing", "unverifiable_here", "unverified"]) expect(VERIFY[v]!.label).not.toBe(v);
    for (const j of ["distill", "embed"]) expect(JOB[j]!.label).not.toBe(j);
    for (const r of ["curator", "member", "worker", "reviewer"]) expect(ROLE[r]!.label).not.toBe(r);
    expect(STATUS.candidate!.label).toBe("Waiting for review");
    expect(ORIGIN.distilled!.label).toBe("Learned from a conversation");
    expect(KIND.gotcha!.label).toBe("Pitfall");
  });

  it("says how often a fact was used", () => {
    expect(usedTimes(0)).toBe("Not used yet");
    expect(usedTimes(1)).toBe("Used once");
    expect(usedTimes(5)).toBe("Used 5 times");
  });

  it("an unknown value shows as itself instead of blank", () => {
    expect(word(STATUS, "archived")).toEqual({ label: "archived", hint: "" });
  });

  it("says where a review anchor's words were said; other says nothing", () => {
    expect(Object.fromEntries(Object.entries(WHERE).map(([k, v]) => [k, v.label]))).toEqual({
      factory_plan_note: "in a factory plan approval",
      factory_chat: "in a factory run's chat",
      factory_run: "in a factory run",
      conversation: "in a conversation with Hermes",
      commit: "in a commit",
      other: "",
    });
    expect(WHERE.other!.label).toBe("");
    expect(word(WHERE, "x").label).toBe("x");
  });

  it("re-exports the who-gets-it labels", () => {
    expect(levelLabel({ scope: "global" }).label).toBe("Everyone");
    expect(levelLabel({ scope: "repo:gh/bennybrau/hive" }).label).toBe("Repo: hive");
    expect(levelLabel({ scope: "personal:jon" }).label).toBe("Just me");
  });

  it("lists the raw values the page guard looks for, and none of the words that are fine as they are", () => {
    expect(RAW_VALUES).toEqual(expect.arrayContaining(["candidate", "retracted", "distilled", "ingested", "gotcha", "invariant", "drifted", "unverifiable_here", "global", "distill", "embed"]));
    expect(RAW_VALUES).not.toContain("decision");
  });
});

describe("when", () => {
  it.each([
    [10, "just now"],
    [90, "2 minutes ago"],
    [3 * 3600, "3 hours ago"],
    [26 * 3600, "yesterday"],
    [4 * 86400, "4 days ago"],
  ])("%i seconds ago reads %s", (secs, text) => {
    expect(when(ago(secs), NOW).text).toBe(text);
  });

  it("past a week shows the date, with the year only when it isn't this year", () => {
    expect(when("2026-11-03T12:00:00Z", NOW).text).toBe("Nov 3");
    expect(when("2025-11-03T12:00:00Z", NOW).text).toBe("Nov 3, 2025");
  });

  it("a time in the future (a clock a little ahead) reads just now", () => {
    expect(when(ago(-30), NOW).text).toBe("just now");
  });

  it("always gives the full date and time for a hover", () => {
    expect(when(ago(3600), NOW).title).toMatch(/November 12, 2026/);
  });

  it("an unparseable value comes back as itself", () => {
    expect(when("soon", NOW)).toEqual({ text: "soon", title: "soon" });
  });
});
