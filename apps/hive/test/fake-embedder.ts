import type { Embedder, EmbedKind } from "../src/embed.js";

/**
 * Deterministic stand-in for Ollama in tests: each concept owns one of the 768 dimensions and a
 * text lights up the concepts whose words it contains. Two texts that share NO words but share a
 * concept ("ship to production" / "deploy to Cloud Run") end up close - the property meaning search
 * relies on - without a model in CI. Real-model behaviour is checked by test/ollama.live.test.ts.
 */
const CONCEPTS: string[][] = [
  ["deploy", "deployed", "ship", "production", "release", "cloud run", "rollout"],
  ["payment", "payments", "billing", "invoice", "charge", "money"],
  ["test", "tests", "pytest", "vitest", "coverage"],
  ["owner", "owns", "responsible", "team", "maintainer"],
  ["database", "postgres", "sql", "migration"],
];

export class FakeEmbedder implements Embedder {
  readonly model = "fake-embed";
  calls = 0;
  fail = false;

  /** Exact text -> vector overrides, so a test can set the cosine between two texts. */
  constructor(readonly fixed = new Map<string, number[]>()) {}

  async embed(texts: string[], _kind: EmbedKind) {
    this.calls++;
    if (this.fail) throw new Error("fake embedder down");
    const vectors = texts.map((t) => {
      const fixed = this.fixed.get(t);
      if (fixed) return fixed;
      const lower = t.toLowerCase();
      const v = new Array<number>(768).fill(0);
      CONCEPTS.forEach((words, i) => {
        if (words.some((w) => lower.includes(w))) v[i] = 1;
      });
      v[767] = 0.05; // never a zero vector (cosine undefined)
      return v;
    });
    return { vectors, tokens: texts.join(" ").split(/\s+/).length };
  }
}
