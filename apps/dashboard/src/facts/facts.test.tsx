import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Facts } from "./Facts";
import type { Fact } from "./query";

function fact(id: string, over: Partial<Fact> = {}): Fact {
  return {
    id,
    text: `fact ${id}`,
    kind: "gotcha",
    scope: "global",
    locus: [],
    origin: "authored",
    status: "active",
    status_note: null,
    author_user_id: "u1",
    recorded_at: "2026-10-01T12:00:00Z",
    ...over,
  };
}

const DETAIL = {
  fact: fact("f1", { text: "the open fact", scope: "repo:acme/widgets" }),
  anchors: [
    {
      id: "a1", episode_id: null, repo_key: "acme/widgets", commit_sha: "abc123", path: "src/a.ts", line_start: 10, line_end: 14,
      quote: "const a = 1;", verify_status: "drifted", verified_at: "2026-10-02T00:00:00Z",
      verify_note: "quote changed", found_line: 12, remote_url: "git@github.com:acme/widgets.git",
    },
    {
      id: "a2", episode_id: null, repo_key: "local/other", commit_sha: "def456", path: "README.md", line_start: 3, line_end: 3,
      quote: null, verify_status: "verified", verified_at: null, verify_note: null, found_line: 3, remote_url: null,
    },
  ],
  reviews: [{ action: "fix", note: "tightened wording", new_text: "the open fact", reviewer_user_id: "curator1", created_at: "2026-10-03T00:00:00Z" }],
  supersedes: [{ id: "f0", text: "the older fact", status: "superseded", recorded_at: "2026-09-01T00:00:00Z" }],
  superseded_by: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let listPage: (offset: number) => { facts: Fact[]; has_more: boolean };
let searchHits: Fact[];

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/repos") return json({ repos: [{ key: "acme/widgets" }] });
  if (url.pathname === "/v1/search") return json({ mode: "hybrid", facts: searchHits, results: [] });
  if (url.pathname === "/v1/facts") return json(listPage(Number(url.searchParams.get("offset"))));
  if (url.pathname.startsWith("/v1/facts/")) {
    const id = url.pathname.slice("/v1/facts/".length);
    return id === "f1" ? json(DETAIL) : json({ ...DETAIL, fact: fact(id, { text: `detail ${id}` }), supersedes: [] });
  }
  return json({ error: "not found" }, 404);
});

/** Query params of the most recent call to `path`. */
function lastCall(path: string): URLSearchParams {
  const urls = fetchMock.mock.calls.map(([u]) => new URL(String(u), "http://hive")).filter((u) => u.pathname === path);
  expect(urls.length).toBeGreaterThan(0);
  return urls.at(-1)!.searchParams;
}

const rows = () => screen.getAllByRole("row").filter((r) => r.hasAttribute("data-id"));

beforeEach(() => {
  history.replaceState(null, "", "/facts");
  listPage = () => ({ facts: [fact("f1"), fact("f2"), fact("f3")], has_more: false });
  searchHits = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("facts table", () => {
  it("asks for the first page with no filters", async () => {
    render(<Facts />);
    await screen.findByText("fact f1");
    expect(Object.fromEntries(lastCall("/v1/facts"))).toEqual({ limit: "50", offset: "0" });
  });

  it.each([
    ["Scope", "personal", { scope: "personal" }],
    ["Status", "candidate", { status: "candidate" }],
    ["Origin", "distilled", { origin: "distilled" }],
    ["Kind", "invariant", { kind: "invariant" }],
    ["Repo", "acme/widgets", { scope: "repo:acme/widgets" }],
  ])("the %s filter goes into the request and the URL", async (label, value, expected) => {
    render(<Facts />);
    await screen.findByRole("option", { name: "acme/widgets" });
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await waitFor(() => expect(Object.fromEntries(lastCall("/v1/facts"))).toEqual({ ...expected, limit: "50", offset: "0" }));
    expect(new URLSearchParams(location.search).get(label.toLowerCase())).toBe(value);
  });

  it("keeps the filters in the URL across a remount", async () => {
    const { unmount } = render(<Facts />);
    await screen.findByRole("option", { name: "acme/widgets" });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "personal" } });
    fireEvent.change(screen.getByLabelText("Origin"), { target: { value: "authored" } });
    unmount();
    fetchMock.mockClear();

    render(<Facts />);
    await screen.findByText("fact f1");
    expect(Object.fromEntries(lastCall("/v1/facts"))).toEqual({ scope: "personal", origin: "authored", limit: "50", offset: "0" });
    expect((screen.getByLabelText("Scope") as HTMLSelectElement).value).toBe("personal");
    expect((screen.getByLabelText("Origin") as HTMLSelectElement).value).toBe("authored");
  });

  it("pages by has_more", async () => {
    listPage = (offset) => ({ facts: [fact(`p${offset}`)], has_more: offset === 0 });
    render(<Facts />);
    await screen.findByText("fact p0");
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    const prev = screen.getByRole("button", { name: "Prev" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    fireEvent.click(next);
    await screen.findByText("fact p50");
    expect(lastCall("/v1/facts").get("offset")).toBe("50");
    expect(new URLSearchParams(location.search).get("page")).toBe("1");
    expect(next.disabled).toBe(true);

    fireEvent.click(prev);
    await screen.findByText("fact p0");
    expect(lastCall("/v1/facts").get("offset")).toBe("0");
    expect(location.search).toBe("");
  });

  it("searches, filters the hits here, and says there's no paging", async () => {
    searchHits = [
      fact("s1", { text: "kept hit", scope: "repo:acme/widgets", status: "candidate" }),
      fact("s2", { text: "wrong status", scope: "repo:acme/widgets", status: "active" }),
      fact("s3", { text: "wrong scope", scope: "global", status: "candidate" }),
    ];
    render(<Facts />);
    await screen.findByRole("option", { name: "acme/widgets" });
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "acme/widgets" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "candidate" } });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: " retry budget " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByText("kept hit");
    expect(Object.fromEntries(lastCall("/v1/search"))).toEqual({
      q: "retry budget", source: "fact", k: "100", include_candidates: "true", repo_key: "acme/widgets",
    });
    expect(screen.queryByText("wrong status")).toBeNull();
    expect(screen.queryByText("wrong scope")).toBeNull();
    expect(screen.getByRole("note").textContent).toMatch(/up to 100 matches; filters applied here, no paging/);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(new URLSearchParams(location.search).get("q")).toBe("retry budget");
  });

  it("search mode also applies the origin, kind and personal-scope filters client-side", async () => {
    searchHits = [
      fact("s1", { text: "kept hit", scope: "personal:u1", origin: "authored", kind: "gotcha" }),
      fact("s2", { text: "wrong origin", scope: "personal:u1", origin: "distilled", kind: "gotcha" }),
      fact("s3", { text: "wrong kind", scope: "personal:u1", origin: "authored", kind: "decision" }),
      fact("s4", { text: "wrong scope", scope: "global", origin: "authored", kind: "gotcha" }),
    ];
    render(<Facts />);
    await screen.findByRole("option", { name: "acme/widgets" });
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "personal" } });
    fireEvent.change(screen.getByLabelText("Origin"), { target: { value: "authored" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "gotcha" } });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "retry budget" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByText("kept hit");
    expect(screen.queryByText("wrong origin")).toBeNull();
    expect(screen.queryByText("wrong kind")).toBeNull();
    expect(screen.queryByText("wrong scope")).toBeNull();
  });
});

describe("fact detail", () => {
  it("opens in the path, keeps the query, and shows anchors, chain and reviews", async () => {
    history.replaceState(null, "", "/facts?scope=global");
    render(<Facts />);
    fireEvent.click(await screen.findByText("fact f1"));
    expect(location.pathname + location.search).toBe("/facts/f1?scope=global");

    const panel = await screen.findByRole("complementary", { name: "Fact detail" });
    await within(panel).findByText("the open fact");
    expect(within(panel).getByText("drifted").className).toMatch(/badge/);
    expect(within(panel).getByText("verified").className).toMatch(/badge/);
    expect(within(panel).getByText("quote changed")).toBeTruthy();
    expect(within(panel).getByText("Now found at line 12.")).toBeTruthy();
    const links = within(panel).getAllByRole("link", { name: "View on GitHub" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["https://github.com/acme/widgets/blob/abc123/src/a.ts#L10-L14"]);
    expect(within(panel).getByText("tightened wording")).toBeTruthy();
    expect(within(panel).getByText("fix")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("link", { name: "the older fact" }));
    expect(location.pathname + location.search).toBe("/facts/f0?scope=global");
    expect(await within(panel).findByText("detail f0")).toBeTruthy();
  });

  it("opens straight from a /facts/<id> URL", async () => {
    history.replaceState(null, "", "/facts/f1");
    render(<Facts />);
    expect(await screen.findByText("the open fact")).toBeTruthy();
  });
});

describe("keyboard", () => {
  it("moves a roving row with arrows and j/k, opens with Enter, and Esc returns focus", async () => {
    render(<Facts />);
    await screen.findByText("fact f1");
    expect(rows().map((r) => r.tabIndex)).toEqual([0, -1, -1]);

    act(() => rows()[0]!.focus());
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(document.activeElement!, { key: "j" });
    expect(document.activeElement).toBe(rows()[2]);
    fireEvent.keyDown(document.activeElement!, { key: "k" });
    expect(document.activeElement).toBe(rows()[1]);
    expect(rows().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);

    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(location.pathname).toBe("/facts/f2");
    await screen.findByText("detail f2");

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(location.pathname).toBe("/facts");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(rows()[1]);
  });
});
