import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repos, type Repo } from "./Repos";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function repo(key: string, over: Partial<Repo> = {}): Repo {
  return {
    key, source: "path", url: null, has_token: false, last_fetched_at: null,
    host_path: `/Users/jon/dev/${key.split("/").at(-1)}`, remote_url: null, default_branch: "main",
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
let add: () => Response;
let token: () => Response;
let remove: () => Response;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/repos") return init?.method === "POST" ? add() : json({ repos });
  if (url.pathname === "/v1/repos/files") return json({ files });
  if (url.pathname === "/v1/repos/ingest") return ingest();
  if (String(input) === "/v1/repos/gh%2Facme%2Fproj/token") return token();
  if (String(input) === "/v1/repos/gh%2Facme%2Fproj") return remove();
  return json({ error: "not found" }, 404);
});
const calls = (path: string) => fetchMock.mock.calls.filter(([u]) => new URL(String(u), "http://hive").pathname === path);

beforeEach(() => {
  repos = [repo("gh/acme/proj", { ingest_error: "git failed: bad object" }), repo("local/notes", { last_ingested_at: null, last_ingested_sha: null })];
  files = [];
  ingest = () => json(SYNC);
  add = () => json({ repo: { key: "gh/acme/new" } }, 201);
  token = () => json({ repo: { key: "gh/acme/proj", has_token: true } });
  remove = () => json({ ok: true });
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

const URL_REPO = { source: "url", url: "https://github.com/acme/proj", host_path: null, has_token: true, last_fetched_at: new Date(Date.now() - 3600_000).toISOString() } as const;
const SECRET = "github_pat_SECRET123";
const form = () => screen.getByRole("heading", { name: "Add by URL" }).closest("form") as HTMLElement;
const sent = (path: string, i = 0) => JSON.parse(String(calls(path)[i]![1]!.body)) as unknown;
const posts = () => calls("/v1/repos").filter(([, init]) => init?.method === "POST");

describe("sources by URL", () => {
  it("each row says where it comes from; a URL repo shows only that a token is set", async () => {
    repos = [repo("gh/acme/proj", URL_REPO), repo("local/notes"), repo("gh/acme/fresh", { ...URL_REPO, has_token: false, last_fetched_at: null })];
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const proj = item("gh/acme/proj");
    expect(within(proj).getByText("https://github.com/acme/proj").tagName).toBe("CODE");
    expect(within(proj).getByText(/Cloned from/)).toBeTruthy();
    expect(within(proj).getByText("token set")).toBeTruthy();
    expect(within(proj).getByText("1 hour ago")).toBeTruthy();
    expect(within(proj).queryByText("Folder on this machine")).toBeNull();
    const notes = item("local/notes");
    expect(within(notes).getByText(/Folder on this machine/)).toBeTruthy();
    expect(within(notes).getByText("/Users/jon/dev/notes").closest("details")).toBeTruthy();
    expect(within(notes).queryByText(/Cloned from/)).toBeNull();
    const fresh = item("gh/acme/fresh");
    expect(within(fresh).getByText("Not fetched yet")).toBeTruthy();
    expect(within(fresh).queryByText("token set")).toBeNull();
  });

  it("a curator adds a repo by URL: exact body, busy while cloning, token cleared, then a refetch", async () => {
    let finish!: (r: Response) => void;
    add = () => new Promise<Response>((r) => (finish = r)) as unknown as Response;
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const f = within(form());
    fireEvent.change(f.getByLabelText("GitHub URL"), { target: { value: "https://github.com/acme/new" } });
    fireEvent.change(f.getByLabelText("Key (optional)"), { target: { value: "acme-new" } });
    const tokenInput = f.getByLabelText("Access token (optional, for private repos)") as HTMLInputElement;
    expect(tokenInput.type).toBe("password");
    expect(tokenInput.autocomplete).toBe("off");
    expect(f.getByText("Defaults to gh/owner/repo")).toBeTruthy();
    fireEvent.change(tokenInput, { target: { value: SECRET } });
    fireEvent.click(f.getByRole("button", { name: "Add repo" }));
    expect(((await f.findByRole("button", { name: "Cloning…" })) as HTMLButtonElement).disabled).toBe(true);
    expect(sent("/v1/repos", 1)).toEqual({ url: "https://github.com/acme/new", key: "acme-new", token: SECRET });
    expect(tokenInput.value).toBe("");

    repos = [...repos, repo("acme-new", URL_REPO)];
    finish(json({ repo: { key: "acme-new" } }, 201));
    await screen.findByRole("heading", { name: "acme-new" });
    expect((f.getByLabelText("GitHub URL") as HTMLInputElement).value).toBe("");
    expect((f.getByLabelText("Key (optional)") as HTMLInputElement).value).toBe("");
    expect(f.getByRole("button", { name: "Add repo" })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("leaves out an empty key and token", async () => {
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const f = within(form());
    fireEvent.change(f.getByLabelText("GitHub URL"), { target: { value: "https://github.com/acme/new" } });
    fireEvent.click(f.getByRole("button", { name: "Add repo" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sent("/v1/repos", 1)).toEqual({ url: "https://github.com/acme/new" });
  });

  it("says why an add failed, and clears the token every time", async () => {
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const f = within(form());
    const tokenInput = f.getByLabelText("Access token (optional, for private repos)") as HTMLInputElement;
    const tryAdd = async (res: Response, text: string) => {
      add = () => res;
      fireEvent.change(f.getByLabelText("GitHub URL"), { target: { value: "https://github.com/acme/proj" } });
      fireEvent.change(tokenInput, { target: { value: SECRET } });
      fireEvent.click(f.getByRole("button", { name: "Add repo" }));
      await waitFor(() => expect(f.getByRole("alert").textContent).toBe(text));
      expect(tokenInput.value).toBe("");
      expect(document.body.innerHTML).not.toContain(SECRET);
    };
    await tryAdd(json({ error: "repo gh/acme/proj is already registered (by path)" }, 409), "That key is already registered.");
    await tryAdd(json({ error: "HIVE_SECRET_KEY is not set" }, 503), "Hive can't store tokens: HIVE_SECRET_KEY is not set on the server.");
    await tryAdd(json({ error: "authentication failed: the token was refused" }, 400), "authentication failed: the token was refused");
    expect((f.getByLabelText("GitHub URL") as HTMLInputElement).value).toBe("https://github.com/acme/proj");
    expect(calls("/v1/repos").filter(([, init]) => init?.method !== "POST")).toHaveLength(1);
  });

  it("replaces a URL repo's token with a PUT to the encoded key", async () => {
    repos = [repo("gh/acme/proj", URL_REPO)];
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const proj = item("gh/acme/proj");
    fireEvent.click(within(proj).getByRole("button", { name: "Replace token" }));
    const input = within(proj).getByLabelText("New access token") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(within(proj).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("/v1/repos")).toHaveLength(2));
    const [path, init] = fetchMock.mock.calls.find(([u]) => String(u) === "/v1/repos/gh%2Facme%2Fproj/token")!;
    expect(path).toBe("/v1/repos/gh%2Facme%2Fproj/token");
    expect(init!.method).toBe("PUT");
    expect(JSON.parse(String(init!.body))).toEqual({ token: SECRET });
    expect(within(proj).queryByLabelText("New access token")).toBeNull();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("asks in the row before removing; Cancel sends nothing, Yes deletes and refetches", async () => {
    repos = [repo("gh/acme/proj", URL_REPO), repo("local/notes")];
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const proj = item("gh/acme/proj");
    expect(within(item("local/notes")).queryByRole("button", { name: "Remove" })).toBeNull();
    fireEvent.click(within(proj).getByRole("button", { name: "Remove" }));
    expect(within(proj).getByText("Remove gh/acme/proj? Its indexed docs and clone are deleted; facts stay.")).toBeTruthy();
    expect(within(proj).queryByRole("button", { name: "Read again now" })).toBeNull();
    fireEvent.click(within(proj).getByRole("button", { name: "Cancel" }));
    expect(within(proj).getByRole("button", { name: "Read again now" })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(within(proj).getByRole("button", { name: "Remove" }));
    const yes = within(proj).getByRole("button", { name: "Yes" });
    expect(yes.className).toBe("danger");
    repos = [repos[1]!];
    fireEvent.click(yes);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "gh/acme/proj" })).toBeNull());
    const del = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(del.map(([u]) => String(u))).toEqual(["/v1/repos/gh%2Facme%2Fproj"]);
    expect(calls("/v1/repos")).toHaveLength(2);
  });

  it("shows a failed remove in the row", async () => {
    repos = [repo("gh/acme/proj", URL_REPO)];
    remove = () => json({ error: "repo gh/acme/proj not found" }, 404);
    render(<Repos role="curator" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    const proj = item("gh/acme/proj");
    fireEvent.click(within(proj).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(proj).getByRole("button", { name: "Yes" }));
    expect((await within(proj).findByRole("alert")).textContent).toBe("repo gh/acme/proj not found");
    expect(within(proj).getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("members see no add form and no token or remove buttons", async () => {
    repos = [repo("gh/acme/proj", URL_REPO)];
    render(<Repos role="member" />);
    await screen.findByRole("heading", { name: "gh/acme/proj" });
    expect(screen.queryByRole("heading", { name: "Add by URL" })).toBeNull();
    expect(screen.queryByLabelText("GitHub URL")).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace token" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
