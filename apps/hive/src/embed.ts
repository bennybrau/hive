/**
 * Embeddings for meaning search. Optional by design: every caller must work keyword-only when
 * the embedder is missing or down (an un-embedded row is still findable by keyword).
 */

export type EmbedKind = "query" | "document";

export interface Embedder {
  readonly model: string;
  embed(texts: string[], kind: EmbedKind, opts?: { timeoutMs?: number }): Promise<{ vectors: number[][]; tokens: number }>;
}

/** nomic-embed-text is trained with task prefixes; without them query/doc similarity is noticeably worse. */
const NOMIC_PREFIX: Record<EmbedKind, string> = { query: "search_query: ", document: "search_document: " };

export class OllamaEmbedder implements Embedder {
  constructor(
    private readonly baseUrl: string,
    readonly model: string,
  ) {}

  async embed(texts: string[], kind: EmbedKind, opts: { timeoutMs?: number } = {}) {
    const prefix = this.model.startsWith("nomic-embed") ? NOMIC_PREFIX[kind] : "";
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: texts.map((t) => prefix + t),
        truncate: true, // long episodes: embed the head rather than fail (chunking comes with M3 docs)
        keep_alive: "30m", // keep the model warm so hot-path query embeds stay ~5 ms
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ollama /api/embed ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { embeddings: number[][]; prompt_eval_count?: number };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error("ollama /api/embed returned the wrong number of embeddings");
    }
    return { vectors: data.embeddings, tokens: data.prompt_eval_count ?? 0 };
  }
}

/** pgvector text literal. */
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

export function createEmbedder(ollamaUrl: string, model: string): Embedder | null {
  return ollamaUrl ? new OllamaEmbedder(ollamaUrl, model) : null;
}
