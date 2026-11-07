import type { FastifyInstance } from "fastify";
import { buildBrief } from "../brief.js";
import type { SearchDeps } from "../search.js";

/** Task brief: pure SQL plus one local query embedding, no LLM (see brief.ts). */
export function briefRoutes(app: FastifyInstance, deps: SearchDeps): void {
  app.post<{ Body: { task: string; repo_key: string; changed_paths?: string[]; budget_tokens?: number } }>(
    "/v1/brief",
    {
      schema: {
        body: {
          type: "object",
          required: ["task", "repo_key"],
          properties: {
            task: { type: "string", minLength: 1, maxLength: 4000 },
            repo_key: { type: "string", minLength: 1 },
            changed_paths: { type: "array", maxItems: 200, items: { type: "string", maxLength: 1000 } },
            budget_tokens: { type: "integer", minimum: 100, maximum: 4000, default: 600 },
          },
        },
      },
    },
    async (req) => {
      const { task, repo_key, changed_paths, budget_tokens } = req.body;
      return buildBrief(deps, req.instance!, {
        task, repoKey: repo_key, changedPaths: changed_paths ?? [], budgetTokens: budget_tokens ?? 600,
      });
    },
  );
}
