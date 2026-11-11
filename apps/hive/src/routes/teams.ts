import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  addRepo, createTeam, deleteTeam, listTeams, removeMember, removeRepo, setMember, TEAM_KEY_PATTERN, TEAM_ROLES, TeamError,
  teamsOf, type TeamRole,
} from "../teams.js";

const KEY = { type: "string", minLength: 1, maxLength: 64, pattern: TEAM_KEY_PATTERN } as const;
const keyParams = { type: "object", required: ["key"], properties: { key: KEY } } as const;
const memberParams = {
  type: "object", required: ["key", "user_id"], properties: { key: KEY, user_id: { type: "string", minLength: 1, maxLength: 200 } },
} as const;
const repoParams = {
  type: "object", required: ["key", "repo_key"], properties: { key: KEY, repo_key: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

function curatorOnly(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.instance!.role === "curator") return true;
  reply.code(403).send({ error: "only a curator can change teams" });
  return false;
}

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TeamError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

/** Anyone can list teams and their own; only a curator creates or deletes a team or changes its members and repos. */
export function teamRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get("/v1/teams", async () => ({ teams: await listTeams(pool) }));

  app.get("/v1/teams/mine", async (req) => ({ teams: await teamsOf(pool, req.instance!.user_id) }));

  app.post<{ Body: { key: string; name: string } }>(
    "/v1/teams",
    {
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["key", "name"],
          properties: { key: KEY, name: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      return handle(reply, async () => reply.code(201).send({ team: await createTeam(pool, req.body.key, req.body.name) }));
    },
  );

  app.delete<{ Params: { key: string } }>("/v1/teams/:key", { schema: { params: keyParams } }, async (req, reply) => {
    if (!curatorOnly(req, reply)) return reply;
    return handle(reply, async () => {
      await deleteTeam(pool, req.params.key);
      return { deleted: req.params.key };
    });
  });

  app.put<{ Params: { key: string; user_id: string }; Body: { role: TeamRole } }>(
    "/v1/teams/:key/members/:user_id",
    {
      schema: {
        params: memberParams,
        body: { type: "object", additionalProperties: false, required: ["role"], properties: { role: { enum: [...TEAM_ROLES] } } },
      },
    },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      return handle(reply, async () => ({ team: await setMember(pool, req.params.key, req.params.user_id, req.body.role) }));
    },
  );

  app.delete<{ Params: { key: string; user_id: string } }>(
    "/v1/teams/:key/members/:user_id",
    { schema: { params: memberParams } },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      return handle(reply, async () => ({ team: await removeMember(pool, req.params.key, req.params.user_id) }));
    },
  );

  app.put<{ Params: { key: string; repo_key: string } }>(
    "/v1/teams/:key/repos/:repo_key",
    { schema: { params: repoParams } },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      return handle(reply, async () => ({ team: await addRepo(pool, req.params.key, req.params.repo_key) }));
    },
  );

  app.delete<{ Params: { key: string; repo_key: string } }>(
    "/v1/teams/:key/repos/:repo_key",
    { schema: { params: repoParams } },
    async (req, reply) => {
      if (!curatorOnly(req, reply)) return reply;
      return handle(reply, async () => ({ team: await removeRepo(pool, req.params.key, req.params.repo_key) }));
    },
  );
}
