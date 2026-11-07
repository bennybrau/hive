import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { quoteValid, type Label } from "../src/eval/score.js";

const dir = fileURLToPath(new URL("../../../scripts/eval-distill/cases/", import.meta.url));
const cases = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

// distill-v5 must quote a user turn for every fact, so an expected label is only findable when its evidence is one.
describe("eval-distill cases", () => {
  it("has cases", () => expect(cases.length).toBeGreaterThan(0));
  for (const f of cases) {
    const meta = JSON.parse(readFileSync(join(dir, f), "utf8")) as { expected: Label[] };
    const transcript = readFileSync(join(dir, f.replace(/\.json$/, ".txt")), "utf8");
    meta.expected.forEach((l, i) => {
      it(`${f} E${i + 1} has evidence quoting a user turn`, () => {
        expect(quoteValid(l.evidence ?? "", transcript)).toBe(true);
      });
    });
  }
});
