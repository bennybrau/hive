import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { workerOnly } from "../auth.js";
import {
  claimJob,
  completeJob,
  DISTILL_PROMPT_VERSION,
  failJob,
  type DistilledFact,
  type DistillNotifier,
  type DistillUsage,
} from "../distill.js";
import type { Embedder } from "../embed.js";
import { ConflictError, FACT_KINDS } from "../facts.js";
import { getAgentCredential } from "./settings.js";

/** How often a long-polling claim re-checks the queue when nothing kicks it. */
const RECHECK_MS = 1_000;

export interface WorkerDeps {
  pool: pg.Pool;
  embedder: Embedder | null;
  secretKey: Buffer | null;
  notifier: DistillNotifier;
  claimWaitMs: number;
  leaseSeconds: number;
  onWrite: () => void;
}

const idParams = { type: "object", properties: { id: { type: "string", format: "uuid" } } } as const;

/** The fact-agent container's endpoints: claim a distill job (long-poll), then complete or fail it. */
export function workerRoutes(app: FastifyInstance, deps: WorkerDeps): void {
  const { pool } = deps;

  app.post("/v1/worker/distill/claim", async (req, reply) => {
    if (!workerOnly(req, reply)) return reply;
    const credential = deps.secretKey ? await getAgentCredential(pool, deps.secretKey) : null;
    if (!credential) return reply.code(503).send({ error: "agent credential not set" });

    // Stop waiting if the client goes away (the response closes before we answer).
    const gone = new AbortController();
    const onClose = () => gone.abort();
    reply.raw.on("close", onClose);
    try {
      const deadline = Date.now() + deps.claimWaitMs;
      for (;;) {
        const claimed = await claimJob(pool, req.instance!.id, deps.leaseSeconds);
        if (claimed) return { ...claimed, prompt_version: DISTILL_PROMPT_VERSION, credential };
        const left = deadline - Date.now();
        if (left <= 0 || gone.signal.aborted) break;
        await deps.notifier.wait(Math.min(RECHECK_MS, left), gone.signal);
        if (gone.signal.aborted) break;
      }
      return reply.code(204).send();
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  app.post<{ Params: { id: string }; Body: { facts: DistilledFact[]; usage: DistillUsage } }>(
    "/v1/worker/distill/:id/complete",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["facts", "usage"],
          properties: {
            facts: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "kind", "scope", "quote"],
                properties: {
                  text: { type: "string", minLength: 3, maxLength: 2000 },
                  kind: { type: "string", enum: [...FACT_KINDS] },
                  scope: { type: "string", minLength: 1, maxLength: 220 },
                  quote: { type: "string", minLength: 1, maxLength: 4000 },
                  locus: { type: "array", maxItems: 50, items: { type: "string", maxLength: 500 } },
                  replaces: { type: "string", maxLength: 100 },
                },
              },
            },
            usage: {
              type: "object",
              additionalProperties: false,
              required: ["model", "input_tokens", "output_tokens", "cache_read_tokens", "cost_usd", "duration_ms"],
              properties: {
                model: { type: "string", minLength: 1, maxLength: 200 },
                input_tokens: { type: "integer", minimum: 0 },
                output_tokens: { type: "integer", minimum: 0 },
                cache_read_tokens: { type: "integer", minimum: 0 },
                cost_usd: { type: "number", minimum: 0 },
                duration_ms: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      if (!workerOnly(req, reply)) return reply;
      try {
        const result = await completeJob(pool, req.params.id, req.instance!, req.body, deps.embedder);
        if (!result) return reply.code(404).send({ error: "no such job" });
        if (result.created.length) deps.onWrite();
        return { result };
      } catch (err) {
        if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { error: string } }>(
    "/v1/worker/distill/:id/fail",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["error"],
          properties: { error: { type: "string", minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (req, reply) => {
      if (!workerOnly(req, reply)) return reply;
      try {
        const job = await failJob(pool, req.params.id, req.instance!, req.body.error);
        if (!job) return reply.code(404).send({ error: "no such job" });
        return { job };
      } catch (err) {
        if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );
}
