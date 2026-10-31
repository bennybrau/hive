import type { FastifyInstance } from "fastify";
import { embedQuery, searchDocs, searchEpisodes, searchFacts, type SearchDeps, type TextHit } from "../search.js";

const SOURCES = ["fact", "conversation", "history", "commit", "doc"] as const;
type Source = (typeof SOURCES)[number];

/**
 * Hot path. Pure SQL plus one local query embedding (~5 ms warm); no LLM calls.
 * If the embedder is down, both endpoints answer keyword-only and say so in `mode`.
 */
export function searchRoutes(app: FastifyInstance, deps: SearchDeps): void {
  app.get<{ Querystring: { q: string; repo_key?: string; k?: number; min_sim?: number; changed?: string } }>(
    "/v1/recall",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 2000 },
            repo_key: { type: "string" },
            k: { type: "integer", minimum: 1, maximum: 50, default: 10 },
            // Strict gate for prefetch: drop any hit (keyword matches included) whose cosine
            // similarity to the question is below this. Un-embedded rows are kept.
            min_sim: { type: "number", minimum: 0, maximum: 1 },
            // comma-separated repo-relative paths the caller has changed (git status); facts whose
            // locus or anchors are there rank higher
            changed: { type: "string", maxLength: 20000 },
          },
        },
      },
    },
    async (req) => {
      const { q, repo_key, k, min_sim, changed } = req.query;
      const qvec = await embedQuery(deps.embedder, q);
      const changedPaths = changed ? changed.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200) : undefined;
      const facts = await searchFacts(deps, req.instance!, {
        q, repoKey: repo_key, k: k ?? 10, statuses: ["active"], qvec, minSimilarity: min_sim, changedPaths,
      });
      return { mode: qvec ? "hybrid" : "keyword", facts };
    },
  );

  app.get<{ Querystring: { q: string; source?: string; repo_key?: string; k?: number; include_candidates?: boolean } }>(
    "/v1/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 2000 },
            source: { type: "string", default: "all" }, // all | comma list of fact,conversation,history,commit,doc
            repo_key: { type: "string" },
            k: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            include_candidates: { type: "boolean", default: false },
          },
        },
      },
    },
    async (req, reply) => {
      const { q, repo_key, include_candidates } = req.query;
      const k = req.query.k ?? 20;
      const raw = req.query.source ?? "all";
      const sources = raw === "all" ? [...SOURCES] : (raw.split(",").map((s) => s.trim()) as Source[]);
      const bad = sources.filter((s) => !SOURCES.includes(s));
      if (bad.length) return reply.code(400).send({ error: `unknown source ${bad.join(",")}`, valid: ["all", ...SOURCES] });

      const who = req.instance!;
      const qvec = await embedQuery(deps.embedder, q);
      const statuses = include_candidates ? ["active", "candidate"] : ["active"];
      const [facts, conversation, history, commit, doc] = await Promise.all([
        sources.includes("fact") ? searchFacts(deps, who, { q, repoKey: repo_key, k, statuses, qvec }) : [],
        sources.includes("conversation") ? searchEpisodes(deps, who, "conversation", { q, k, qvec }) : [],
        sources.includes("history") ? searchEpisodes(deps, who, "history", { q, k, qvec }) : [],
        sources.includes("commit") ? searchEpisodes(deps, who, "commit", { q, k, qvec, repoKey: repo_key }) : [],
        sources.includes("doc") ? searchDocs(deps, { q, repoKey: repo_key, k, qvec }) : [],
      ]);
      const text: TextHit[] = [...conversation, ...history, ...commit, ...doc].sort((a, b) => b.score - a.score).slice(0, k);
      return { mode: qvec ? "hybrid" : "keyword", facts, results: text };
    },
  );
}
