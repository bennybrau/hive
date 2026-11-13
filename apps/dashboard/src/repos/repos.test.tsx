import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repos, type Repo } from "./Repos";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function repo(key: string, over: Partial<Repo> = {}): Repo {
  return {
    key, host_path: `/Users/jon/dev/${key.split("/").at(-1)}`, remote_url: null, default_branch: "main",
    last_ingested_sha: SHA, last_ingested_at: new Date(Date.now() - 3 * 3600_000).toISOString(), ingest_error: null,
    docs: 12, chunks: 80, commits: 300,
    anchors: { verified: 4, drifted: 1, missing: 2, unverifiable_here: 0, unverified: 3 },
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SYNC = {
  key: "gh/acme/proj",
  ingest: { head: SHA, docs: { indexed: 2, unchanged: 10, empty: 0, skipped: 0, error: 0, removed: 1 }, chunks_written: 9, commits_added: 3, ms: 40 },
  verify: { checked: 10, verified: 7, drifted: 1, missing: 2, unverifiable_here: 0, retracted: 0, ms: 5 },
};

let repos: Repo[];
let files: unknown[];
let ingest: () => Response;
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/repos") return json({ repos });
  if (url.pathname === "/v1/repos/files") return json({ files });
  if (url.pathname === "/v1/repos/ingest") return ingest();
  return json({ error: "not found" }, 404);
});
const calls = (path: string) => fetchMock.mock.calls.filter(([u]) => new URL(String(u), "http://hive").pathname === path);

beforeEach(() => {
  repos = [repo("gh/acme/proj", { ingest_error: "git failed: bad object" }), repo("local/notes", { last_ingested_at: null, last_ingested_sha: null })];
  files = [];
  ingest = () => json(SYNC);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (key: string) => document.querySelector(`li[data-key="${key}"]`) as HTMLElement;

describe("repos view", () => {
  it("lists each repo with its ingest state, counts, anchor health and last error", async () => {
    render(<Repos role="member" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const proj = item("gh/acme/proj");
    expect(within(proj).getByText("/Users/jon/dev/proj").closest("details")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sources");
    expect(within(proj).getByText("3 hours ago")).toBeTruthy();
    expect(within(proj).getByText(SHA.slice(0, 7))).toBeTruthy();
    expect(within(proj).getByText("12 docs, 80 chunks, 300 commits")).toBeTruthy();
    const health = within(proj).getByLabelText("Anchor health");
    expect(within(health).getByText("4 Still matches").className).toBe("badge verify-verified");
    expect(within(health).getByText("1 Source changed").className).toBe("badge verify-drifted");
    expect(within(health).getByText("1 Source changed").title).toBe("The lines this fact quotes have changed since");
    expect(within(health).getByText("2 Source gone")).toBeTruthy();
    expect(within(health).getByText("3 Not checked yet")).toBeTruthy();
    expect(within(proj).getByText(/git failed: bad object/).className).toBe("error");
    expect(within(item("local/notes")).getByText("Not read yet")).toBeTruthy();
  });

  it("expands to the files that weren't indexed, fetching them once", async () => {
    files = [
      { path: "README.md", status: "indexed", note: null, chunks: 3 },
      { path: "docs/scan.pdf", status: "empty", note: "no text layer (scanned PDF?)", chunks: 0 },
    ];
    render(<Repos role="member" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const proj = item("gh/acme/proj");
    const toggle = within(proj).getByRole("button", { name: "Files not indexed" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await within(proj).findByText("docs/scan.pdf")).toBeTruthy();
    expect(within(proj).getByText("no text layer (scanned PDF?)")).toBeTruthy();
    expect(within(proj).queryByText("README.md")).toBeNull();
    expect(new URL(String(calls("/v1/repos/files")[0]![0]), "http://hive").searchParams.get("key")).toBe("gh/acme/proj");

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(calls("/v1/repos/files")).toHaveLength(1);

    files = [{ path: "README.md", status: "indexed", note: null, chunks: 3 }];
    const notes = item("local/notes");
    fireEvent.click(within(notes).getByRole("button", { name: "Files not indexed" }));
    expect(await within(notes).findByText("All files indexed.")).toBeTruthy();
  });

  it("a curator reads a repo again now: busy while running, then the summaries, then a refetch", async () => {
    let finish!: (r: Response) => void;
    ingest = () => new Promise<Response>((r) => (finish = r)) as unknown as Response;
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const proj = item("gh/acme/proj");
    fireEvent.click(within(proj).getByRole("button", { name: "Read again now" }));
    const busy = await within(proj).findByRole("button", { name: "Reading…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(JSON.parse(String(calls("/v1/repos/ingest")[0]![1]!.body))).toEqual({ key: "gh/acme/proj" });

    repos = [repo("gh/acme/proj", { docs: 13 }), repos[1]!];
    finish(json(SYNC));
    const status = await within(proj).findByRole("status");
    expect(status.textContent).toContain("2 docs indexed");
    expect(status.textContent).toContain("Checked 10 quotes: 7 Still matches, 1 Source changed, 2 Source gone");
    expect((within(proj).getByRole("button", { name: "Read again now" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(within(item("gh/acme/proj")).getByText("13 docs, 80 chunks, 300 commits")).toBeTruthy());
    expect(calls("/v1/repos")).toHaveLength(2);
  });

  it("says when an ingest is already running, and shows the hive's error otherwise", async () => {
    ingest = () => json({ error: "gh/acme/proj is busy" }, 409);
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const proj = item("gh/acme/proj");
    fireEvent.click(within(proj).getByRole("button", { name: "Read again now" }));
    expect((await within(proj).findByRole("alert")).textContent).toMatch(/already reading/);

    ingest = () => json({ error: "repo path is gone" }, 400);
    fireEvent.click(within(proj).getByRole("button", { name: "Read again now" }));
    await waitFor(() => expect(within(proj).getByRole("alert").textContent).toBe("repo path is gone"));
    expect(calls("/v1/repos")).toHaveLength(1);
  });

  it("says how a repo gets added when there are none", async () => {
    repos = [];
    render(<Repos role="member" />);
    expect((await screen.findByRole("heading", { name: "No repos yet" })).parentElement!.textContent).toContain("pointing Hive at its checkout");
  });

  it("members don't get a Read again now button", async () => {
    render(<Repos role="member" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    expect(screen.queryByRole("button", { name: "Read again now" })).toBeNull();
  });
});
