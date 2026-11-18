import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance } from "../src/auth.js";
import { fetchRepo, gitErrorText, parseCloneUrl, RepoError } from "../src/git.js";
import { createRepoSync, type RepoSync } from "../src/jobs/repo-sync.js";
import { decryptSecret } from "../src/secrets.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";
import { commit, makeRepo, sh, write } from "./repo-fixtures.js";

const TOKEN = "ghp_SuperSecretToken1234567890";
const b64 = (t: string) => Buffer.from(`x-access-token:${t}`).toString("base64");

let pool: pg.Pool;
let app: FastifyInstance;
let sync: RepoSync;
let fetchSpy: ReturnType<typeof vi.fn<typeof fetchRepo>>;
let auth: { authorization: string };
let reader: { authorization: string };
let clonesRoot: string;
let logs: string[];
let src: ReturnType<typeof makeRepo>;
let bare: string;
const secretKey = randomBytes(32);

/** A work repo pushing to a bare repo; the bare repo's file:// URL is what gets registered. */
function makeRemote() {
  src = makeRepo({ "README.md": "# Widget\n\nThe widget uses pnpm.\n" });
  bare = path.join(src.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  sh(src.dir, "remote", "add", "origin", bare);
  sh(src.dir, "push", "-q", "origin", "main");
  return `file://${bare}`;
}

function build(opts: { secretKey?: Buffer | null; allowFileUrls?: boolean } = {}) {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  return buildApp(pool, {
    version: "test",
    logger: { level: "trace", stream },
    embedder: new FakeEmbedder(),
    repos: {
      roots: { root: src.root, hostRoot: src.root },
      sync,
      clonesRoot,
      allowFileUrls: opts.allowFileUrls ?? true,
      secretKey: opts.secretKey === undefined ? secretKey : opts.secretKey,
    },
  });
}

const post = (body: unknown, a: FastifyInstance = app) => a.inject({ method: "POST", url: "/v1/repos", headers: auth, payload: body as object });
const list = async () => (await app.inject({ url: "/v1/repos", headers: auth })).json().repos as Record<string, unknown>[];
const repoRow = async (key: string) => (await pool.query("select * from repos where key = $1", [key])).rows[0];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate team_repos, teams, reviews, anchors, facts, episodes, doc_chunks, doc_files, repos, instances cascade");
  clonesRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-clones-")));
  logs = [];
  fetchSpy = vi.fn(fetchRepo);
  sync = createRepoSync(pool, {
    maxCommits: 500, intervalMin: 0, log: (m) => logs.push(m), clonesRoot, allowFileUrls: true, secretKey, fetch: fetchSpy,
  });
  makeRemote();
  app = build();
  auth = { authorization: `Bearer ${(await createInstance(pool, { name: "c", userId: "jon", role: "curator" })).token}` };
  reader = { authorization: `Bearer ${(await createInstance(pool, { name: "m", userId: "ann", role: "member" })).token}` };
});
afterEach(async () => {
  await sync.stop();
  await app.close();
  src.cleanup();
  rmSync(clonesRoot, { recursive: true, force: true });
});

describe("parseCloneUrl", () => {
  it("accepts only https://github.com/<o>/<r>(.git)", () => {
    expect(parseCloneUrl("https://github.com/acme/widget")).toBe("https://github.com/acme/widget");
    expect(parseCloneUrl("https://github.com/acme/widget.git")).toBe("https://github.com/acme/widget.git");
    for (const bad of [
      "git@github.com:acme/widget.git",
      "ssh://git@github.com/acme/widget.git",
      "http://github.com/acme/widget",
      "https://gitlab.com/acme/widget",
      "https://github.com/acme",
      "https://github.com/acme/widget/tree/main",
      "https://github.com/acme/..",
      "file:///tmp/x.git",
      "/tmp/x.git",
    ]) {
      expect(() => parseCloneUrl(bad), bad).toThrow(RepoError);
    }
    expect(parseCloneUrl("file:///tmp/x.git", { allowFile: true })).toBe("file:///tmp/x.git");
  });

  it("POST refuses ssh, file: (without the flag), http and other hosts with 400", async () => {
    const strict = build({ allowFileUrls: false });
    for (const url of ["git@github.com:acme/w.git", `file://${bare}`, "http://github.com/acme/w", "https://gitlab.com/acme/w"]) {
      const res = await post({ url, key: "gh/acme/w" }, strict);
      expect(res.statusCode, url).toBe(400);
    }
    await strict.close();
    expect(await repoRow("gh/acme/w")).toBeUndefined();
  });
});

describe("gitErrorText", () => {
  it("maps stderr to plain text and removes the token and its base64", () => {
    expect(gitErrorText(`remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/a/b/'`, TOKEN)).toBe(
      "authentication failed: the token was refused or expired",
    );
    expect(gitErrorText("fatal: could not read Username for 'https://github.com': terminal prompts disabled", null)).toMatch(/^authentication failed/);
    expect(gitErrorText("remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found", null)).toBe("repository not found");
    const net = gitErrorText(`fatal: unable to access 'https://github.com/a/b/': Could not resolve host: ${TOKEN} ${b64(TOKEN)}`, TOKEN);
    expect(net).toMatch(/^network: Could not resolve host/);
    expect(net).not.toContain(TOKEN);
    expect(net).not.toContain(b64(TOKEN));
  });
});

describe("register by URL", () => {
  it("clones, ingests, and a re-sync after a push picks up the new commit", async () => {
    const res = await post({ url: `file://${bare}`, key: "gh/acme/widget" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().repo).toMatchObject({ key: "gh/acme/widget", source: "url", has_token: false, host_path: null });
    const dir = path.join(clonesRoot, "gh/acme/widget");
    expect(existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(readdirSync(clonesRoot).filter((f) => f.startsWith(".clone-"))).toEqual([]);

    const first = await app.inject({ method: "POST", url: "/v1/repos/ingest", headers: auth, payload: { key: "gh/acme/widget" } });
    expect(first.statusCode, first.body).toBe(200);
    await pool.query("update repos set last_fetched_at = null where key = 'gh/acme/widget'");

    write(src.dir, { "docs/deploy.md": "# Deploy\n\nDeploys go out from main.\n" });
    commit(src.dir, "add deploy doc");
    sh(src.dir, "push", "-q", "origin", "main");
    const head = sh(src.dir, "rev-parse", "HEAD").trim();

    await sync.sync("gh/acme/widget");
    const row = await repoRow("gh/acme/widget");
    expect(row.last_ingested_sha).toBe(head);
    expect(row.ingest_error).toBeNull();
    expect(row.last_fetched_at).toBeInstanceOf(Date);
    expect(existsSync(path.join(dir, "docs/deploy.md"))).toBe(true); // verify reads the reset working tree
    const docs = await pool.query("select path from doc_files where repo_key = 'gh/acme/widget' order by path collate \"C\"");
    expect(docs.rows.map((r) => r.path)).toEqual(["README.md", "docs/deploy.md"]);

    const [listed] = await list();
    expect(listed).toMatchObject({ key: "gh/acme/widget", source: "url", url: `file://${bare}`, has_token: false, host_path: null });
    expect(listed!.last_fetched_at).toBeTruthy();
  });

  it("only a curator registers", async () => {
    const res = await post({ url: `file://${bare}`, key: "gh/acme/widget" }, app);
    expect(res.statusCode).toBe(201);
    const member = await app.inject({ method: "POST", url: "/v1/repos", headers: reader, payload: { url: `file://${bare}`, key: "gh/acme/x" } });
    expect(member.statusCode).toBe(403);
  });

  it("refuses a body with both path and url", async () => {
    expect((await post({ url: `file://${bare}`, path: "proj", key: "gh/acme/widget" })).statusCode).toBe(400);
    expect((await post({ path: "proj", token: TOKEN })).statusCode).toBe(400);
  });

  it("a failed clone leaves nothing behind", async () => {
    const res = await post({ url: `file://${src.root}/nope.git`, key: "gh/acme/nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("repository not found");
    expect(readdirSync(clonesRoot)).toEqual([]);
    expect(await repoRow("gh/acme/nope")).toBeUndefined();
  });

  it("409 when the key exists, in both directions; a path repo still re-registers", async () => {
    expect((await post({ url: `file://${bare}`, key: "gh/acme/widget" })).statusCode).toBe(201);
    const pathOverUrl = await post({ path: "proj", key: "gh/acme/widget" });
    expect(pathOverUrl.statusCode).toBe(409);
    expect((await repoRow("gh/acme/widget")).source).toBe("url");
    expect((await post({ url: `file://${bare}`, key: "gh/acme/widget" })).statusCode).toBe(409);

    expect((await post({ path: "proj", key: "local/proj" })).statusCode).toBe(201);
    expect((await post({ path: "proj", key: "local/proj" })).statusCode).toBe(200);
    const urlOverPath = await post({ url: `file://${bare}`, key: "local/proj" });
    expect(urlOverPath.statusCode).toBe(409);
    expect(existsSync(path.join(clonesRoot, "local/proj"))).toBe(false);
  });

  it("503 for a token when HIVE_SECRET_KEY is unset", async () => {
    const noKey = build({ secretKey: null });
    const res = await post({ url: `file://${bare}`, key: "gh/acme/widget", token: TOKEN }, noKey);
    expect(res.statusCode).toBe(503);
    expect((await post({ url: `file://${bare}`, key: "gh/acme/widget" }, noKey)).statusCode).toBe(201);
    await noKey.close();
  });

  it("the token is stored encrypted and appears in no .git file, GET body or log", async () => {
    const res = await post({ url: `file://${bare}`, key: "gh/acme/widget", token: TOKEN });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.body).not.toContain(TOKEN);
    const row = await repoRow("gh/acme/widget");
    expect(decryptSecret(row.token_enc, secretKey)).toBe(TOKEN);

    await sync.sync("gh/acme/widget");
    expect(fetchSpy).toHaveBeenCalledWith(expect.any(String), `file://${bare}`, "main", TOKEN);
    const ingest = await app.inject({ method: "POST", url: "/v1/repos/ingest", headers: auth, payload: { key: "gh/acme/widget" } });
    expect(ingest.statusCode, ingest.body).toBe(200);

    const gitDir = path.join(clonesRoot, "gh/acme/widget/.git");
    expect(statSync(gitDir).isDirectory()).toBe(true);
    for (const f of filesUnder(gitDir)) {
      const body = readFileSync(f).toString("latin1");
      expect(body.includes(TOKEN) || body.includes(b64(TOKEN)), f).toBe(false);
    }
    const get = await app.inject({ url: "/v1/repos", headers: auth });
    expect(get.body).not.toContain(TOKEN);
    expect(get.body).not.toContain("token_enc");
    expect(get.json().repos[0].has_token).toBe(true);
    const put = await app.inject({ method: "PUT", url: "/v1/repos/gh%2Facme%2Fwidget/token", headers: auth, payload: { token: `${TOKEN}x` } });
    expect(put.statusCode).toBe(200);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(b64(TOKEN));
    }
  });
});

describe("fetch failures", () => {
  it("an unreachable remote sets a network: ingest_error and keeps the last good index", async () => {
    expect((await post({ url: `file://${bare}`, key: "gh/acme/widget" })).statusCode).toBe(201);
    await sync.sync("gh/acme/widget");
    const before = await repoRow("gh/acme/widget");

    await pool.query("update repos set clone_url = 'https://github.com/acme/widget' where key = 'gh/acme/widget'");
    const proxy = process.env.https_proxy;
    process.env.https_proxy = "http://127.0.0.1:1"; // nothing listens there
    try {
      await expect(sync.sync("gh/acme/widget")).rejects.toBeInstanceOf(RepoError);
    } finally {
      if (proxy === undefined) delete process.env.https_proxy;
      else process.env.https_proxy = proxy;
    }
    const after = await repoRow("gh/acme/widget");
    expect(after.ingest_error).toMatch(/^network: /);
    expect(after.last_ingested_sha).toBe(before.last_ingested_sha);
    expect(after.last_ingested_at).toEqual(before.last_ingested_at);
    expect(after.last_fetched_at).toEqual(before.last_fetched_at);
    const docs = await pool.query("select count(*)::int as n from doc_files where repo_key = 'gh/acme/widget'");
    expect(docs.rows[0].n).toBe(1);
  });

  it("a timer pass logs a fetch failure and carries on with the other repos", async () => {
    expect((await post({ url: `file://${bare}`, key: "gh/acme/widget" })).statusCode).toBe(201);
    expect((await post({ path: "proj", key: "local/proj" })).statusCode).toBe(201);
    await pool.query("update repos set clone_url = $1 where key = 'gh/acme/widget'", [`file://${src.root}/gone.git`]);
    const out = await sync.syncAll();
    expect(out).toEqual([{ key: "gh/acme/widget", error: "repository not found" }, expect.objectContaining({ key: "local/proj" })]);
    expect(logs.some((l) => l.includes("repo sync gh/acme/widget: repository not found"))).toBe(true);
  });
});

describe("path repos", () => {
  it("never fetch", async () => {
    expect((await post({ path: "proj", key: "local/proj" })).statusCode).toBe(201);
    await sync.sync("local/proj");
    await sync.syncAll();
    expect(fetchSpy).not.toHaveBeenCalled();
    const [listed] = await list();
    expect(listed).toMatchObject({ source: "path", url: null, has_token: false, last_fetched_at: null, host_path: src.dir });
  });
});

describe("PUT /v1/repos/:key/token", () => {
  it("replaces a URL repo's token; 400 for a path repo, 404 for none, 503 without a key", async () => {
    expect((await post({ url: `file://${bare}`, key: "gh/acme/widget", token: TOKEN })).statusCode).toBe(201);
    const put = (key: string, a = app) =>
      a.inject({ method: "PUT", url: `/v1/repos/${encodeURIComponent(key)}/token`, headers: auth, payload: { token: "ghp_new" } });
    const res = await put("gh/acme/widget");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ repo: { key: "gh/acme/widget", has_token: true } });
    expect(decryptSecret((await repoRow("gh/acme/widget")).token_enc, secretKey)).toBe("ghp_new");

    expect((await post({ path: "proj", key: "local/proj" })).statusCode).toBe(201);
    expect((await put("local/proj")).statusCode).toBe(400);
    expect((await put("gh/acme/none")).statusCode).toBe(404);
    const noKey = build({ secretKey: null });
    expect((await put("gh/acme/widget", noKey)).statusCode).toBe(503);
    await noKey.close();
    const member = await app.inject({ method: "PUT", url: "/v1/repos/gh%2Facme%2Fwidget/token", headers: reader, payload: { token: "x" } });
    expect(member.statusCode).toBe(403);
  });
});

describe("DELETE /v1/repos/:key", () => {
  it("removes the row, its team links and docs, and the clone dir; facts' episodes stay", async () => {
    expect((await post({ url: `file://${bare}`, key: "gh/acme/widget" })).statusCode).toBe(201);
    await sync.sync("gh/acme/widget");
    await pool.query("insert into teams (key, name) values ('core', 'Core')");
    await pool.query("insert into team_repos (team_key, repo_key) values ('core', 'gh/acme/widget')");
    const dir = path.join(clonesRoot, "gh/acme/widget");

    const member = await app.inject({ method: "DELETE", url: "/v1/repos/gh%2Facme%2Fwidget", headers: reader });
    expect(member.statusCode).toBe(403);
    const res = await app.inject({ method: "DELETE", url: "/v1/repos/gh%2Facme%2Fwidget", headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    expect(await repoRow("gh/acme/widget")).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    for (const t of ["team_repos", "doc_files", "doc_chunks"]) {
      const { rows } = await pool.query(`select count(*)::int as n from ${t} where repo_key = 'gh/acme/widget'`);
      expect(rows[0].n, t).toBe(0);
    }
    const commits = await pool.query("select count(*)::int as n from episodes where kind = 'commit' and repo_key = 'gh/acme/widget'");
    expect(commits.rows[0].n).toBe(1);
    expect((await app.inject({ method: "DELETE", url: "/v1/repos/gh%2Facme%2Fwidget", headers: auth })).statusCode).toBe(404);
  });

  it("never removes a path repo's directory, or a clone path outside the clones root", async () => {
    expect((await post({ path: "proj", key: "local/proj" })).statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: "/v1/repos/local%2Fproj", headers: auth })).statusCode).toBe(200);
    expect(existsSync(path.join(src.dir, "README.md"))).toBe(true);

    await pool.query("insert into repos (key, source, clone_url, local_path) values ('gh/acme/odd', 'url', 'https://github.com/acme/odd', $1)", [src.dir]);
    expect((await app.inject({ method: "DELETE", url: "/v1/repos/gh%2Facme%2Fodd", headers: auth })).statusCode).toBe(200);
    expect(existsSync(path.join(src.dir, "README.md"))).toBe(true);
  });
});
