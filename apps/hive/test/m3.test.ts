import { rmSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createInstance, type Instance } from "../src/auth.js";
import { chunkText } from "../src/chunk.js";
import { extractText } from "../src/extract.js";
import { createFact } from "../src/facts.js";
import { cleanRelPath, RepoError, repoKeyFromRemote, resolveRepoPath } from "../src/git.js";
import { runEmbedPass } from "../src/jobs/embed.js";
import { isIndexedDoc } from "../src/jobs/ingest.js";
import { createRepoSync, RepoBusyError, type RepoSync } from "../src/jobs/repo-sync.js";
import { locate, verifyAnchors } from "../src/jobs/verify.js";
import { overlaps } from "../src/search.js";
import { FakeEmbedder } from "./fake-embedder.js";
import { freshDb } from "./helpers.js";
import { commit, docx, makeRepo, pdf, pptx, sh, write, xlsx } from "./repo-fixtures.js";

let pool: pg.Pool;
let app: FastifyInstance;
let sync: RepoSync;
let embedder: FakeEmbedder;
let curator: { instance: Instance; token: string };
let alice: { instance: Instance; token: string };
let repo: ReturnType<typeof makeRepo>;

const KEY = "gh/acme/proj";
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const post = (token: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: auth(token), payload: payload as object });
const get = (token: string, url: string) => app.inject({ url, headers: auth(token) });

const SETTINGS_MD = [
  "# Settings",
  "",
  "Intro paragraph about configuration.",
  "",
  "## Gate policy",
  "",
  "GATE_POLICY controls when the factory may merge without a human.",
  "Set GATE_POLICY=strict to require two approvals on every change.",
  "",
  "## Ports",
  "",
  "The dashboard listens on port 4100.",
].join("\n");

function newApp(roots: { root: string; hostRoot: string }) {
  sync = createRepoSync(pool, { maxCommits: 500, intervalMin: 0, log: () => {} });
  app = buildApp(pool, { version: "test", embedder, minSimilarity: 0.5, repos: { roots, sync } });
}

async function register(body: Record<string, unknown> = { path: repo.dir }) {
  return post(curator.token, "/v1/repos", body);
}
async function ingest() {
  const res = await post(curator.token, "/v1/repos/ingest", { key: KEY });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("truncate llm_calls, reviews, anchors, facts, episodes, doc_chunks, doc_files, repos, instances cascade");
  embedder = new FakeEmbedder();
  curator = await createInstance(pool, { name: "jon-mac", userId: "jon", role: "curator" });
  alice = await createInstance(pool, { name: "alice-laptop", userId: "alice" });
  repo = makeRepo(
    {
      "README.md": "# Proj\n\nThe factory deploys to Cloud Run.\n",
      "docs/settings.md": SETTINGS_MD,
      "docs/plan.docx": docx(["Rollout plan", "Billing moves to the new invoice service in March."]),
      "docs/deck.pptx": pptx([{ lines: ["Quarterly review"], notes: "Mention the payments migration." }, { lines: ["Owners", "Team Atlas owns ingestion"] }]),
      "docs/costs.xlsx": xlsx("Budget", [["Item", "Monthly"], ["Postgres", 120]]),
      "docs/spec.pdf": pdf(["Retention policy: keep audit logs for 400 days."]),
      "docs/scan.pdf": pdf(),
      "src/app.ts": "export const port = 4100; // dashboard\n",
      "test/fixtures/sample.pdf": pdf(["fixture"]),
      "node_modules/x/README.md": "vendored\n",
    },
    { remote: "git@github.com:acme/proj.git" },
  );
  newApp({ root: repo.root, hostRoot: repo.root });
});
afterEach(async () => {
  await sync.stop();
  await app.close();
  repo.cleanup();
});

describe("units", () => {
  it("repo key from remote: same rule as the plugin", () => {
    expect(repoKeyFromRemote("git@github.com:acme/proj.git")).toBe("gh/acme/proj");
    expect(repoKeyFromRemote("https://github.com/acme/proj")).toBe("gh/acme/proj");
    expect(repoKeyFromRemote("ssh://git@gitlab.example.com/team/x.git")).toBe("gitlab.example.com/team/x");
    expect(repoKeyFromRemote("")).toBe("");
  });

  it("which files are indexed: markdown anywhere, office/pdf only at root or in docs/, never vendored", () => {
    expect(isIndexedDoc("README.md")).toBe(true);
    expect(isIndexedDoc("apps/x/NOTES.md")).toBe(true);
    expect(isIndexedDoc("docs/spec.pdf")).toBe(true);
    expect(isIndexedDoc("apps/x/docs/deck.pptx")).toBe(true);
    expect(isIndexedDoc("test/fixtures/sample.pdf")).toBe(false);
    expect(isIndexedDoc("notes.txt")).toBe(true);
    expect(isIndexedDoc("src/notes.txt")).toBe(false);
    expect(isIndexedDoc("node_modules/x/README.md")).toBe(false);
    expect(isIndexedDoc("src/app.ts")).toBe(false);
  });

  it("chunks keep exact 1-based line ranges and split at headings", () => {
    const filler = "word ".repeat(80).trim(); // ~400 chars, so a heading after it starts a new chunk
    const text = ["# A", "", filler, "", "## B", "", "line seven", "line eight"].join("\n");
    const chunks = chunkText(text);
    expect(chunks.map((c) => [c.lineStart, c.lineEnd])).toEqual([[1, 3], [5, 8]]);
    const lines = text.split("\n");
    for (const c of chunks) expect(c.content).toBe(lines.slice(c.lineStart - 1, c.lineEnd).join("\n").replace(/\n\n+/g, "\n\n"));
    expect(chunkText("")).toEqual([]);
    // an oversized paragraph is split, ranges stay inside it and in order
    const big = Array.from({ length: 200 }, (_, i) => `row ${i} ${"x".repeat(30)}`).join("\n");
    const parts = chunkText(big);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts[0]!.lineStart).toBe(1);
    expect(parts.at(-1)!.lineEnd).toBe(200);
    parts.slice(1).forEach((p, i) => expect(p.lineStart).toBe(parts[i]!.lineEnd + 1));
  });

  it("extracts Word, PowerPoint (with notes), Excel and PDF text; a scanned PDF is empty", async () => {
    expect(await extractText("a.docx", Buffer.from(docx(["One & two", "Three"])))).toBe("One & two\nThree");
    const deck = await extractText("a.pptx", Buffer.from(pptx([{ lines: ["Title"], notes: "speaker note" }, { lines: ["Second"] }])));
    expect(deck).toBe("## Slide 1\nTitle\nNotes:\nspeaker note\n\n## Slide 2\nSecond");
    expect(await extractText("a.xlsx", Buffer.from(xlsx("Budget", [["Item", "Cost"], ["DB", 120]])))).toBe("## Sheet: Budget\nItem\tCost\nDB\t120");
    expect(await extractText("a.pdf", pdf(["Hello PDF world"]))).toContain("Hello PDF world");
    expect((await extractText("a.pdf", pdf())).trim()).toBe("");
    await expect(extractText("a.docx", Buffer.from("not a zip"))).rejects.toThrow(/not a valid Office file/);
  });

  it("locate: verified (even when moved), drifted when edited, missing when gone", () => {
    const text = "a\nb\nSet GATE_POLICY=strict to require two approvals.\nc";
    expect(locate(text, "Set GATE_POLICY=strict to require two approvals.", 3)).toMatchObject({ status: "verified", line: 3 });
    expect(locate("x\n".repeat(20) + text, "Set GATE_POLICY=strict to require two approvals.", 3)).toMatchObject({
      status: "verified", line: 23, note: "moved from line 3 to 23",
    });
    // whitespace/wrapping differences are not changes
    expect(locate("Set GATE_POLICY=strict\n   to require two approvals.", "Set GATE_POLICY=strict to require two approvals.", null).status).toBe("verified");
    const edited = locate(text.replace("two", "three"), "Set GATE_POLICY=strict to require two approvals.", 3);
    expect(edited).toMatchObject({ status: "drifted", line: 3 });
    expect(locate("totally different content here", "Set GATE_POLICY=strict to require two approvals.", 3).status).toBe("missing");
    // the same quote twice: pick the occurrence nearest where it was last seen
    const twice = ["x", "dup line here", ...Array(27).fill("y"), "dup line here"].join("\n");
    expect(locate(twice, "dup line here", 2)).toMatchObject({ status: "verified", line: 2, note: "quote found" });
    expect(locate(twice, "dup line here", 29)).toMatchObject({ status: "verified", line: 30 });
  });

  it("overlaps: a locus entry matches the file itself or a directory containing it", () => {
    expect(overlaps(["apps/hive/src/search.ts"], ["apps/hive/src/search.ts"])).toBe(true);
    expect(overlaps(["apps/hive/"], ["./apps/hive/src/x.ts"])).toBe(true);
    expect(overlaps(["apps/hive"], ["apps/hivemind/x.ts"])).toBe(false);
    expect(overlaps([], ["a"])).toBe(false);
    expect(cleanRelPath("../etc/passwd")).toBeNull();
    expect(cleanRelPath("./docs/a.md")).toBe("docs/a.md");
  });
});

describe("register", () => {
  it("curator registers by host path; key comes from origin; members cannot", async () => {
    expect((await post(alice.token, "/v1/repos", { path: repo.dir })).statusCode).toBe(403);
    const res = await register();
    expect(res.statusCode).toBe(201);
    expect(res.json().repo).toMatchObject({ key: KEY, host_path: repo.dir, default_branch: "main" });
    expect((await register()).statusCode).toBe(200); // idempotent
    const list = (await get(alice.token, "/v1/repos")).json().repos;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: KEY, host_path: repo.dir });
  });

  it("maps host paths onto the container mount and refuses paths outside it", async () => {
    // service sees the root at repo.root; the user knows it as /Users/someone/dev
    await sync.stop();
    await app.close();
    newApp({ root: repo.root, hostRoot: "/Users/someone/dev" });
    const ok = await register({ path: "/Users/someone/dev/proj" });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().repo.host_path).toBe("/Users/someone/dev/proj");
    expect((await register({ path: "proj" })).statusCode).toBe(200); // relative to the root
    const outside = await register({ path: "/etc" });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().error).toMatch(/outside the repos root/);
    await expect(resolveRepoPath("../..", { root: repo.root, hostRoot: repo.root })).rejects.toThrow(RepoError);
  });

  it("needs a git repo, and a key when there's no origin", async () => {
    write(repo.root, { "plain/readme.md": "x" });
    expect((await register({ path: path.join(repo.root, "plain") })).json().error).toMatch(/not a git repository/);
    sh(repo.dir, "remote", "remove", "origin");
    expect((await register()).json().error).toMatch(/pass key/);
    expect((await register({ path: repo.dir, key: "local/proj" })).statusCode).toBe(201);
  });
});

describe("ingest", () => {
  it("indexes docs of every type with line ranges, records why a file wasn't indexed, and reads commits", async () => {
    await register();
    const out = await ingest();
    expect(out.ingest.docs).toMatchObject({ indexed: 6, empty: 1, error: 0, unchanged: 0 });
    expect(out.ingest.commits_added).toBe(1);

    const files = (await get(curator.token, `/v1/repos/files?key=${KEY}`)).json().files;
    expect(files.map((f: { path: string }) => f.path).sort()).toEqual(
      ["README.md", "docs/costs.xlsx", "docs/deck.pptx", "docs/plan.docx", "docs/scan.pdf", "docs/settings.md", "docs/spec.pdf"],
    );
    expect(files.find((f: { path: string }) => f.path === "docs/scan.pdf")).toMatchObject({ status: "empty", note: "no text layer (scanned PDF?)" });

    // the plan's check: search GATE_POLICY in docs hits the settings doc, at the right lines
    await runEmbedPass(pool, embedder);
    const res = await get(alice.token, `/v1/search?q=GATE_POLICY&source=doc&repo_key=${KEY}`);
    const hit = res.json().results[0];
    expect(hit).toMatchObject({ source: "doc", path: "docs/settings.md", repo_key: KEY });
    const lines = SETTINGS_MD.split("\n");
    expect(lines.slice(hit.line_start - 1, hit.line_end).join("\n")).toContain("GATE_POLICY=strict");

    // office and pdf text is searchable
    for (const [q, p] of [["invoice", "docs/plan.docx"], ["payments migration", "docs/deck.pptx"], ["audit logs retention", "docs/spec.pdf"]]) {
      const r = (await get(alice.token, `/v1/search?q=${encodeURIComponent(q!)}&source=doc`)).json().results;
      expect(r[0]?.path, q).toBe(p);
    }
    // commits are their own source
    const c = (await get(alice.token, `/v1/search?q=initial%20import&source=commit`)).json().results;
    expect(c[0]).toMatchObject({ source: "commit", repo_key: KEY });
    expect(c[0].ref).toMatch(/^[0-9a-f]{40}$/);
    // and appear in the repo list
    expect((await get(alice.token, "/v1/repos")).json().repos[0]).toMatchObject({ docs: 6, commits: 1 });
  });

  it("is incremental: unchanged files and old commits are skipped; edits, new files and deletions are applied", async () => {
    await register();
    await ingest();
    const again = await ingest();
    expect(again.ingest).toMatchObject({ docs: { unchanged: 7, indexed: 0 }, chunks_written: 0, commits_added: 0 });

    const before = (await pool.query("select id from doc_chunks where path = 'README.md'")).rows;
    write(repo.dir, { "docs/settings.md": SETTINGS_MD.replace("4100", "4200"), "docs/new.md": "# New\n\nFresh doc.\n" });
    rmSync(path.join(repo.dir, "docs/costs.xlsx"));
    commit(repo.dir, "move dashboard to 4200");
    const third = await ingest();
    expect(third.ingest.docs).toMatchObject({ indexed: 2, unchanged: 5, removed: 1 });
    expect(third.ingest.commits_added).toBe(1);
    // untouched file kept its rows (not re-embedded); deleted file's chunks are gone
    expect((await pool.query("select id from doc_chunks where path = 'README.md'")).rows).toEqual(before);
    expect((await pool.query("select count(*)::int n from doc_chunks where path = 'docs/costs.xlsx'")).rows[0].n).toBe(0);
    const s = (await pool.query("select string_agg(content, ' ') c from doc_chunks where path = 'docs/settings.md'")).rows[0].c;
    expect(s).toContain("4200");
    expect(s).not.toContain("4100");
  });

  it("indexes what's committed, not unsaved edits in the working tree", async () => {
    write(repo.dir, { "docs/settings.md": "# Draft\n\nhalf-written WIPWORD\n" });
    await register();
    await ingest();
    const c = (await pool.query("select string_agg(content, ' ') c from doc_chunks where path = 'docs/settings.md'")).rows[0].c;
    expect(c).toContain("GATE_POLICY");
    expect(c).not.toContain("WIPWORD");
  });

  it("one ingest per repo at a time", async () => {
    await register();
    const first = sync.sync(KEY);
    await expect(sync.sync(KEY)).rejects.toThrow(RepoBusyError);
    await first;
    await expect(sync.sync(KEY)).resolves.toMatchObject({ key: KEY });
  });

  it("member cannot trigger ingest or verify", async () => {
    await register();
    expect((await post(alice.token, "/v1/repos/ingest", { key: KEY })).statusCode).toBe(403);
    expect((await post(alice.token, "/v1/jobs/verify", {})).statusCode).toBe(403);
  });
});

describe("verify", () => {
  const QUOTE = "Set GATE_POLICY=strict to require two approvals on every change.";
  async function factWithAnchor(origin: "authored" | "ingested", anchor: Record<string, unknown>, text = "GATE_POLICY=strict needs two approvals") {
    const { fact } = await createFact(pool, { text, kind: "convention", scope: `repo:${KEY}`, origin, anchors: [{ repo_key: KEY, ...anchor }] }, curator.instance);
    return fact;
  }
  async function anchorOf(factId: string) {
    return (await pool.query("select verify_status, verify_note, found_line, line_start from anchors where fact_id = $1", [factId])).rows[0];
  }

  it("the plan's check: edit the quoted line -> drifted; git checkout -> verified", async () => {
    await register();
    const f = await factWithAnchor("authored", { path: "docs/settings.md", line_start: 8, quote: QUOTE });
    await ingest(); // ingest runs verify for the repo
    expect(await anchorOf(f.id)).toMatchObject({ verify_status: "verified", found_line: 8 });

    write(repo.dir, { "docs/settings.md": SETTINGS_MD.replace("two approvals", "three approvals") });
    await post(curator.token, "/v1/jobs/verify", { repo_key: KEY });
    expect(await anchorOf(f.id)).toMatchObject({ verify_status: "drifted", found_line: 8 });

    sh(repo.dir, "checkout", "--", "docs/settings.md");
    const v = (await post(curator.token, "/v1/jobs/verify", { repo_key: KEY })).json().verify;
    expect(v).toMatchObject({ checked: 1, verified: 1 });
    expect(await anchorOf(f.id)).toMatchObject({ verify_status: "verified" });
  });

  it("a moved quote is still verified and says where it went; a deleted file is missing", async () => {
    await register();
    const f = await factWithAnchor("authored", { path: "docs/settings.md", line_start: 8, quote: QUOTE });
    write(repo.dir, { "docs/settings.md": "# Moved\n\n" + "filler\n".repeat(10) + SETTINGS_MD });
    await verifyAnchors(pool, { repoKey: KEY });
    expect(await anchorOf(f.id)).toMatchObject({ verify_status: "verified", found_line: 20, verify_note: "moved from line 8 to 20" });

    rmSync(path.join(repo.dir, "docs/settings.md"));
    await verifyAnchors(pool, { repoKey: KEY, missingRetryMs: 0 });
    expect(await anchorOf(f.id)).toMatchObject({ verify_status: "missing", verify_note: "file deleted" });
    // authored facts are not retracted by verify (a human said it; a reviewer decides)
    expect((await pool.query("select status from facts where id = $1", [f.id])).rows[0].status).toBe("active");
  });

  it("an ingested fact whose source is gone on two passes in a row is retracted, with a note", async () => {
    await register();
    const f = await factWithAnchor("ingested", { path: "src/app.ts", quote: "export const port = 4100;" }, "dashboard port is 4100");
    const statusOf = async () => (await pool.query("select status from facts where id = $1", [f.id])).rows[0].status;
    await verifyAnchors(pool, { repoKey: KEY });
    expect(await statusOf()).toBe("active");
    write(repo.dir, { "src/app.ts": "export const host = 'x';\n" });
    // one missing pass could be a half-finished edit: flagged, not retracted
    expect(await verifyAnchors(pool, { repoKey: KEY })).toMatchObject({ missing: 1, retracted: 0 });
    expect(await statusOf()).toBe("active");
    // back again before the next pass: nothing happens
    write(repo.dir, { "src/app.ts": "export const port = 4100; // dashboard\n" });
    expect(await verifyAnchors(pool, { repoKey: KEY })).toMatchObject({ verified: 1 });
    write(repo.dir, { "src/app.ts": "export const host = 'x';\n" });
    await verifyAnchors(pool, { repoKey: KEY });
    const v = await verifyAnchors(pool, { repoKey: KEY });
    expect(v).toMatchObject({ missing: 1, retracted: 1 });
    expect((await pool.query("select status, status_note from facts where id = $1", [f.id])).rows[0]).toEqual({
      status: "retracted", status_note: "source gone: src/app.ts",
    });
  });

  it("a file that is only briefly gone (mid git checkout) is re-checked, not reported missing", async () => {
    await register();
    const f = await factWithAnchor("authored", { path: "docs/settings.md", line_start: 8, quote: QUOTE });
    const file = path.join(repo.dir, "docs/settings.md");
    rmSync(file);
    setTimeout(() => write(repo.dir, { "docs/settings.md": SETTINGS_MD }), 50); // comes back during the retry wait
    await verifyAnchors(pool, { repoKey: KEY, missingRetryMs: 300 });
    expect(await anchorOf(f.id)).toMatchObject({ verify_status: "verified" });
  });

  it("verifies office/pdf anchors against their extracted text", async () => {
    await register();
    const f = await factWithAnchor("authored", { path: "docs/plan.docx", quote: "Billing moves to the new invoice service in March." }, "billing moves in March");
    await verifyAnchors(pool, { repoKey: KEY });
    expect(await anchorOf(f.id)).toMatchObject({ verify_status: "verified", found_line: 2 });
  });

  it("unverifiable_here when the repo isn't registered or there's nothing to check; conversation quotes are checked", async () => {
    const noRepo = await factWithAnchor("authored", { path: "docs/settings.md", quote: QUOTE });
    const { fact: bare } = await createFact(pool, { text: "we like small PRs", kind: "preference", scope: "global", origin: "authored", anchors: [{}] }, curator.instance);
    const ep = (await pool.query("insert into episodes (kind, user_id, content) values ('turn', 'jon', 'user: we decided to use Postgres 16 for the hive') returning id")).rows[0].id;
    const { fact: conv } = await createFact(
      pool,
      { text: "the hive uses Postgres 16", kind: "decision", scope: "global", origin: "authored", anchors: [{ episode_id: ep, quote: "use Postgres 16" }] },
      curator.instance,
    );
    await verifyAnchors(pool);
    expect(await anchorOf(noRepo.id)).toMatchObject({ verify_status: "unverifiable_here", verify_note: `repo ${KEY} not registered` });
    expect(await anchorOf(bare.id)).toMatchObject({ verify_status: "unverifiable_here" });
    expect(await anchorOf(conv.id)).toMatchObject({ verify_status: "verified", verify_note: "quote found in conversation" });
  });

  it("recall reports each fact's worst anchor status", async () => {
    await register();
    const f = await factWithAnchor("authored", { path: "docs/settings.md", quote: QUOTE });
    await runEmbedPass(pool, embedder);
    const r1 = (await get(alice.token, `/v1/recall?q=GATE_POLICY&repo_key=${KEY}`)).json().facts[0];
    expect(r1).toMatchObject({ id: f.id, verify: null });
    write(repo.dir, { "docs/settings.md": SETTINGS_MD.replace("two approvals", "three approvals") });
    await verifyAnchors(pool, { repoKey: KEY });
    const r2 = (await get(alice.token, `/v1/recall?q=GATE_POLICY&repo_key=${KEY}`)).json().facts[0];
    expect(r2).toMatchObject({ id: f.id, verify: "drifted" });
  });
});

describe("locus", () => {
  it("recall ranks facts located in the caller's changed files higher, and says so", async () => {
    const mk = async (text: string, locus: string[]) =>
      (await createFact(pool, { text, kind: "gotcha", scope: "global", origin: "authored", locus }, curator.instance)).fact;
    // same words, so they tie on relevance; only locus can separate them
    const a = await mk("deploy script must run migrations first (a)", ["infra/deploy.sh"]);
    const b = await mk("deploy script must run migrations first (b)", ["apps/web/"]);
    await runEmbedPass(pool, embedder);
    const q = "/v1/recall?q=deploy%20script%20migrations";
    const plain = (await get(alice.token, q)).json().facts.map((f: { id: string }) => f.id);
    expect(plain).toHaveLength(2);
    expect(plain[0]).toBe(a.id); // a ties-by-order first without locus
    const withB = (await get(alice.token, `${q}&changed=apps/web/src/page.tsx,README.md`)).json().facts;
    expect(withB.map((f: { id: string }) => f.id)).toEqual([b.id, a.id]);
    expect(withB.map((f: { near_changes: boolean }) => f.near_changes)).toEqual([true, false]);
    // anchors count as locus too
    await pool.query("insert into anchors (fact_id, path) values ($1, 'infra/deploy.sh')", [a.id]);
    await pool.query("update facts set locus = '{}' where id = $1", [a.id]);
    const withA = (await get(alice.token, `${q}&changed=infra/deploy.sh`)).json().facts;
    expect(withA[0].id).toBe(a.id);
  });
});
