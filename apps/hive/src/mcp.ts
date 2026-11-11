import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import type { Instance } from "./auth.js";
import type { Brief } from "./brief.js";
import { FACT_KINDS, SupersedeError } from "./facts.js";
import { repoKeyFromRemote } from "./repo-key.js";
import { brief } from "./routes/brief.js";
import { remember } from "./routes/facts.js";
import { parseSources, recall, search, SOURCES, type SearchResult } from "./routes/search.js";
import { status, type StatusOpts } from "./routes/status.js";
import { MAX_ALSO_REPOS, ScopeError } from "./scope.js";
import type { SearchDeps, TextHit } from "./search.js";

export interface McpDeps {
  search: SearchDeps;
  onWrite: () => void;
  status: StatusOpts;
}

/** Same budget as the plugin's first-turn brief (BRIEF_BUDGET_TOKENS). */
const BRIEF_BUDGET_TOKENS = 600;

const INSTRUCTIONS =
  "Hive is the team's shared memory: decisions, conventions, gotchas, who owns what. " +
  "Call hive_brief once at the start of a task in a repository (pass `git remote get-url origin` as remote_url). " +
  "Call hive_recall before re-deriving something the team may already know. " +
  "Cite a fact you rely on by its tag, as [hive:<id8>].";

const CITE = "Each fact carries a [hive:<id8>] tag: cite it when you rely on the fact.";

const repoArgs = {
  remote_url: z.string().max(1000).optional().describe("The repository's `git remote get-url origin`; the Hive turns it into a repo key."),
  repo_key: z.string().min(1).max(200).optional().describe("Repo key (e.g. gh/owner/name); wins over remote_url."),
};
const alsoRepos = z
  .array(z.string().max(500))
  .max(MAX_ALSO_REPOS)
  .optional()
  .describe(`Up to ${MAX_ALSO_REPOS} other repo keys (e.g. gh/owner/name) to read too, when the task spans repos.`);

/** One fact as the plugin shows it: `- [hive:<id8>] text (scope, kind[, note])`, personal scopes just "personal". */
export function factLine(f: { id: string; text: string; kind: string; scope: string; verify?: string | null }): string {
  const label = f.scope.startsWith("personal:") ? "personal" : f.scope;
  const note = ({ drifted: ", source changed since", missing: ", source gone" } as Record<string, string>)[f.verify ?? ""] ?? "";
  return `- [hive:${f.id.slice(0, 8)}] ${f.text.trim()} (${label}, ${f.kind}${note})`;
}

const playbookItem = (s: { text: string; fact_ids?: string[] }) =>
  `${s.text.trim()}${(s.fact_ids ?? []).map((id) => ` [hive:${id.slice(0, 8)}]`).join("")}`;

/** The plugin's format_brief; "" when the brief has nothing. */
export function formatBrief(b: Brief): string {
  const count = b.playbook.length + b.gotchas.length + b.facts.length + b.locations.length + b.runs.length + b.tests.length;
  if (!count) return "";
  const lines = ["## Hive brief for this task (shared team memory) - cite a fact you use as [hive:<id>]"];
  for (const pb of b.playbook) {
    lines.push(`Playbook: ${pb.title} (${pb.scope})`);
    if (pb.steps.length) lines.push("Steps:", ...pb.steps.map((s, i) => `${i + 1}. ${playbookItem(s)}`));
    if (pb.pitfalls.length) lines.push("Pitfalls:", ...pb.pitfalls.map((s) => `- ${playbookItem(s)}`));
  }
  if (b.gotchas.length) lines.push("Gotchas:", ...b.gotchas.map(factLine));
  if (b.facts.length) lines.push("Facts:", ...b.facts.map(factLine));
  if (b.locations.length) lines.push(`Where to look: ${b.locations.map((l) => l.ref || l.path).join(", ")}`);
  if (b.runs.length) {
    lines.push("Past runs:");
    for (const r of b.runs) lines.push(`- ${r.title || r.ref}${r.pr_url ? ` (${r.pr_url})` : ""}`);
  }
  if (b.tests.length) lines.push(`Tests: ${b.tests.map((t) => t.path).join(", ")}`);
  return lines.join("\n");
}

/** The plugin's _slim_hit as one line: source, where (doc path:lines, commit sha, ref or episode id), repo, snippet without markup. */
export function hitLine(h: TextHit): string {
  let where: string;
  if (h.path) where = `${h.path}${h.line_start ? `:${h.line_start}-${h.line_end}` : ""}`;
  else if (h.ref) where = h.source === "commit" ? h.ref.slice(0, 10) : h.ref;
  else where = `id ${h.id}`;
  const repo = h.repo_key ? ` (${h.repo_key})` : "";
  return `- ${h.source} ${where}${repo}: ${h.snippet.replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim()}`;
}

function formatSearch(r: SearchResult): string {
  if (!r.facts.length && !r.results.length) return "Nothing in the Hive matches.";
  const lines: string[] = [];
  if (r.facts.length) lines.push("## Hive facts - cite a fact you use as [hive:<id>]", ...r.facts.map(factLine));
  if (r.results.length) lines.push("## Docs, commits and history - cite a doc as path:line", ...r.results.map(hitLine));
  return lines.join("\n");
}

const text = (lines: string[], isError = false): CallToolResult => ({
  content: [{ type: "text", text: lines.filter(Boolean).join("\n") }],
  ...(isError ? { isError: true } : {}),
});

/**
 * The repo a call is about: repo_key wins over remote_url. Notes say what couldn't be used
 * (an unparseable remote_url, a repo the Hive hasn't registered); neither is an error.
 */
async function resolveRepo(deps: McpDeps, args: { remote_url?: string; repo_key?: string }): Promise<{ repoKey?: string; notes: string[] }> {
  const notes: string[] = [];
  let repoKey = args.repo_key?.trim() || undefined;
  if (!repoKey && args.remote_url?.trim()) {
    repoKey = repoKeyFromRemote(args.remote_url) || undefined;
    if (!repoKey) notes.push(`Note: could not read a repo key from remote_url ${JSON.stringify(args.remote_url)}.`);
  }
  if (repoKey) {
    const { rowCount } = await deps.search.pool.query("select 1 from repos where key = $1", [repoKey]);
    if (!rowCount) notes.push(`Note: ${repoKey} is not a registered repo, so it has no indexed docs or commits.`);
  }
  return { repoKey, notes };
}

const unknownNote = (unknown: string[] | undefined) =>
  unknown?.length ? `Note: also_repos not registered, not read: ${unknown.join(", ")}.` : "";

function buildServer(deps: McpDeps, who: Instance, log: FastifyBaseLogger): McpServer {
  const server = new McpServer({ name: "hive", version: deps.status.version }, { instructions: INSTRUCTIONS });
  const guard = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ScopeError || err instanceof SupersedeError) return text([err.message], true);
      throw err;
    }
  };

  server.registerTool(
    "hive_brief",
    {
      description:
        "The first-turn briefing for a task in a repository, from the team's shared memory (Hive): playbook, gotchas, " +
        `facts, where to look, past runs, nearby tests. Call it once at the start of a task. ${CITE}`,
      inputSchema: { task: z.string().min(1).max(4000).describe("The task, in the user's words."), ...repoArgs, also_repos: alsoRepos },
    },
    (args) =>
      guard(async () => {
        const { repoKey, notes } = await resolveRepo(deps, args);
        if (!repoKey) return text([...notes, "hive_brief needs the repository: pass remote_url (git remote get-url origin) or repo_key."], true);
        const b = await brief(deps.search, who, {
          task: args.task, repoKey, changedPaths: [], budgetTokens: BRIEF_BUDGET_TOKENS, alsoRepos: args.also_repos,
        }, log);
        return text([...notes, unknownNote(b.unknown_repos), formatBrief(b) || `The Hive has nothing for this task in ${repoKey}.`]);
      }),
  );

  server.registerTool(
    "hive_recall",
    {
      description:
        "Look up the team's shared memory (Hive) for facts relevant to a question: decisions, conventions, gotchas, " +
        "who owns what. Use before re-deriving something the team may already know. Facts only: for the repo's own " +
        `docs and commit history use hive_search. ${CITE}`,
      inputSchema: {
        q: z.string().min(1).max(2000).describe("Natural-language question or keywords."),
        ...repoArgs,
        also_repos: alsoRepos,
        k: z.number().int().min(1).max(50).optional().describe("Max facts (default 10)."),
      },
    },
    (args) =>
      guard(async () => {
        const { repoKey, notes } = await resolveRepo(deps, args);
        const r = await recall(deps.search, who, { q: args.q, repoKey, alsoRepos: args.also_repos, k: args.k ?? 10 }, log);
        const body = r.facts.length
          ? ["## Hive (shared team memory) - cite a fact you use as [hive:<id>]", ...r.facts.map(factLine)]
          : ["No matching facts in the Hive."];
        return text([...notes, unknownNote(r.unknown_repos), ...body]);
      }),
  );

  server.registerTool(
    "hive_search",
    {
      description:
        "Search the Hive by keyword or meaning across facts, your own past conversations and session history, and the " +
        "indexed docs and commit messages of the repository (plus also_repos; every repo when none is given). " +
        `Doc hits give path and line range: cite as path:line. Use it when facts don't answer and before reading files yourself. ${CITE}`,
      inputSchema: {
        q: z.string().min(1).max(2000),
        ...repoArgs,
        also_repos: alsoRepos,
        source: z.string().max(200).optional().describe(`all (default) or a comma list of ${SOURCES.join(",")}`),
        k: z.number().int().min(1).max(100).optional().describe("Max results per list (default 10)."),
      },
    },
    (args) =>
      guard(async () => {
        const { sources, bad } = parseSources(args.source ?? "all");
        if (bad.length) return text([`unknown source ${bad.join(",")} (use all or ${SOURCES.join(",")})`], true);
        const { repoKey, notes } = await resolveRepo(deps, args);
        const r = await search(deps.search, who, { q: args.q, sources, repoKey, alsoRepos: args.also_repos, k: args.k ?? 10 });
        return text([...notes, unknownNote(r.unknown_repos), formatSearch(r)]);
      }),
  );

  server.registerTool(
    "hive_remember",
    {
      description:
        "Save a durable fact to the team's shared memory. Only for things still true and useful weeks from now that aren't " +
        "obvious from the code or README: decisions and why, invariants, gotchas, ownership, conventions. Not for task " +
        "progress or to-dos. Shared facts (repo/global) from non-curators wait for curator review; personal facts are " +
        "visible only to this user.",
      inputSchema: {
        text: z.string().min(3).max(2000).describe("One self-contained statement."),
        kind: z.enum(FACT_KINDS),
        scope: z.enum(["repo", "global", "personal"]).describe("repo = this repository; global = applies everywhere; personal = only you."),
        ...repoArgs,
      },
    },
    (args) =>
      guard(async () => {
        const { repoKey, notes } = args.scope === "repo" ? await resolveRepo(deps, args) : { repoKey: undefined, notes: [] };
        if (args.scope === "repo" && !repoKey) {
          return text([...notes, "scope=repo needs the repository: pass remote_url or repo_key, or use scope=global."], true);
        }
        const { fact, deduped } = await remember(deps.search.pool, who, { text: args.text, kind: args.kind, scope: args.scope, repo_key: repoKey }, deps.onWrite);
        const note = deduped
          ? `already known (${fact.status}); nothing new saved`
          : fact.status === "candidate"
            ? "saved as a candidate; the curator must approve it before other assistants see it"
            : fact.status === "active"
              ? "saved and active"
              : fact.status;
        return text([...notes, `[hive:${fact.id.slice(0, 8)}] status ${fact.status}, ${fact.scope.startsWith("personal:") ? "personal" : fact.scope}: ${note}`]);
      }),
  );

  server.registerTool(
    "hive_status",
    { description: "Check the connection to the team's shared Hive memory: who this instance is, counts, embedding health." },
    () =>
      guard(async () => {
        const s = await status(deps.search.pool, deps.status, who);
        const e = s.embeddings;
        return text([
          `Hive ${s.version}: connected as ${who.name} (user ${who.user_id}, ${who.role}).`,
          `Counts: ${s.counts.facts} facts, ${s.counts.episodes} episodes, ${s.counts.repos} repos, ${s.counts.instances} instances.`,
          `Embeddings: ${e.state}${e.model ? ` (${e.model})` : ""}, backlog ${e.backlog}${e.error ? `; error: ${e.error}` : ""}.`,
        ]);
      }),
  );
  return server;
}

/**
 * MCP over streamable HTTP, stateless: each POST gets its own server and transport, JSON answers only
 * (no sessions, no SSE). Mounted behind bearerAuth and confineWorker like /v1.
 */
export function mcpRoutes(app: FastifyInstance, deps: McpDeps): void {
  app.post("/mcp", async (req, reply) => {
    const server = buildServer(deps, req.instance!, req.log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  const notAllowed = { error: "the Hive's MCP endpoint is stateless: POST only" };
  app.get("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send(notAllowed));
  app.delete("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send(notAllowed));
}
