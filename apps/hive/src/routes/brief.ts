import type { FastifyInstance } from "fastify";
import { buildBrief } from "../brief.js";
import { recordUse } from "../facts.js";
import { MAX_ALSO_REPOS, ScopeError } from "../scope.js";
import type { SearchDeps } from "../search.js";

/** Task brief: pure SQL plus one local query embedding, no LLM (see brief.ts). */
export function briefRoutes(app: FastifyInstance, deps: SearchDeps): void {
  app.post<{ Body: { task: string; repo_key: string; changed_paths?: string[]; budget_tokens?: number; also_repos?: string[] } }>(
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
            // other repos to read too; unregistered ones come back in unknown_repos
            also_repos: { type: "array", maxItems: MAX_ALSO_REPOS, items: { type: "string", maxLength: 500 } },
          },
        },
      },
    },
    async (req, reply) => {
      const { task, repo_key, changed_paths, budget_tokens, also_repos } = req.body;
      let brief;
      try {
        brief = await buildBrief(deps, req.instance!, {
          task, repoKey: repo_key, changedPaths: changed_paths ?? [], budgetTokens: budget_tokens ?? 600, alsoRepos: also_repos,
        });
      } catch (err) {
        if (err instanceof ScopeError) return reply.code(400).send({ error: err.message });
        throw err;
      }
      await recordUse(deps.pool, [...brief.gotchas, ...brief.facts].map((f) => f.id), req.log);
      return brief;
    },
  );
}
