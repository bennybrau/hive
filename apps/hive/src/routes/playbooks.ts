import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  createPlaybook, getPlaybook, listPlaybooks, PlaybookError, retractPlaybook, updatePlaybook, type PlaybookInput,
} from "../playbooks.js";
import { resolveScope, ScopeError } from "../scope.js";

const itemSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 1000 },
    fact_ids: { type: "array", maxItems: 20, items: { type: "string", format: "uuid" } },
  },
} as const;

const bodyProperties = {
  scope: { type: "string", minLength: 1, maxLength: 220 },
  repo_key: { type: "string", minLength: 1, maxLength: 200 },
  title: { type: "string", minLength: 1, maxLength: 200 },
  applies_paths: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
  applies_words: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 1000 } },
  steps: { type: "array", maxItems: 20, items: itemSchema },
  pitfalls: { type: "array", maxItems: 20, items: itemSchema },
} as const;

const idParams = { type: "object", properties: { id: { type: "string", format: "uuid" } } } as const;

type Body = Partial<PlaybookInput> & { repo_key?: string };

function curatorOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.instance!.role === "curator") return true;
  reply.code(403).send({ error: "only a curator can change playbooks" });
  return false;
}

/** Playbooks live in shared scopes only: global or repo:<key> (not team scopes, yet). */
async function sharedScope(pool: pg.Pool, req: FastifyRequest, scope: string, repoKey?: string): Promise<string> {
  if (scope === "team" || scope.startsWith("team:")) throw new PlaybookError(400, "a playbook can't be in a team scope (use global or repo)");
  let resolved: string;
  try {
    resolved = await resolveScope(pool, scope, req.instance!, { repoKey });
  } catch (err) {
    if (err instanceof ScopeError) throw new PlaybookError(400, err.message);
    throw err;
  }
  if (resolved.startsWith("personal:")) throw new PlaybookError(400, "a playbook can't be personal (use global or repo)");
  return resolved;
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PlaybookError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

/** Anyone can read active playbooks; only a curator creates, edits (a new version) or retracts one. */
export function playbookRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get<{ Querystring: { scope?: string } }>(
    "/v1/playbooks",
    { schema: { querystring: { type: "object", properties: { scope: { type: "string", maxLength: 220 } } } } },
    async (req) => ({ playbooks: await listPlaybooks(pool, req.query.scope) }),
  );

  app.get<{ Params: { id: string } }>("/v1/playbooks/:id", { schema: { params: idParams } }, async (req, reply) => {
    const playbook = await getPlaybook(pool, req.params.id);
    if (!playbook) return reply.code(404).send({ error: "no such playbook" });
    return { playbook };
  });

  app.post<{ Body: Body }>(
    "/v1/playbooks",
    { schema: { body: { type: "object", additionalProperties: false, required: ["scope", "title"], properties: bodyProperties } } },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      return handle(reply, async () => {
        const { repo_key, ...b } = req.body;
        const scope = await sharedScope(pool, req, b.scope!, repo_key);
        const playbook = await createPlaybook(pool, { ...b, scope, title: b.title! }, req.instance!.user_id);
        return reply.code(201).send({ playbook });
      });
    },
  );

  app.put<{ Params: { id: string }; Body: Body }>(
    "/v1/playbooks/:id",
    { schema: { params: idParams, body: { type: "object", additionalProperties: false, properties: bodyProperties } } },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      return handle(reply, async () => {
        const { repo_key, ...b } = req.body;
        const scope = b.scope === undefined ? undefined : await sharedScope(pool, req, b.scope, repo_key);
        return { playbook: await updatePlaybook(pool, req.params.id, { ...b, scope }, req.instance!.user_id) };
      });
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/playbooks/:id", { schema: { params: idParams } }, async (req, reply) => {
    if (!curatorOnly(req, reply)) return reply;
    return handle(reply, async () => ({ playbook: await retractPlaybook(pool, req.params.id) }));
  });
}
