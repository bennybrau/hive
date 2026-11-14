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

const TEAM = { key: "billing", name: "Billing", created_at: "2026-10-01T00:00:00Z", members: [], repos: [] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let listPage: (offset: number) => { facts: Fact[]; has_more: boolean; total: number };
let searchHits: Fact[];

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/repos") return json({ repos: [{ key: "acme/widgets" }] });
  if (url.pathname === "/v1/teams") return json({ teams: [TEAM] });
  if (url.pathname === "/v1/teams/mine") return json({ teams: [] });
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

const rows = () => [...document.querySelectorAll<HTMLElement>(".kn-list [data-id]")];

beforeEach(() => {
  history.replaceState(null, "", "/facts");
  listPage = () => ({ facts: [fact("f1"), fact("f2"), fact("f3")], has_more: false, total: 3 });
  searchHits = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const menu = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
const picked = (name: string) => menu(name).selectedOptions[0]!.textContent;

function search(q: string) {
  const box = screen.getByRole("searchbox", { name: "Search facts" });
  fireEvent.change(box, { target: { value: q } });
  fireEvent.submit(box.closest("form")!);
}

describe("facts list", () => {
  it("asks for the first page of live facts, and the menus read as their defaults", async () => {
    render(<Facts />);
    await screen.findByText("fact f1");
    expect(Object.fromEntries(lastCall("/v1/facts"))).toEqual({ status: "active", limit: "50", offset: "0" });
    expect(["Status", "Who gets it", "Kind", "Came from"].map(picked)).toEqual(["Live", "For anyone", "Any kind", "From anywhere"]);
    for (const m of screen.getAllByRole("combobox")) expect(m.className).toBe("menu");
    expect(screen.getByRole("searchbox", { name: "Search facts" }).getAttribute("placeholder")).toBe("A topic, a repo, a word");
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  });

  it("counts the facts from the server's total", async () => {
    listPage = () => ({ facts: [fact("f1")], has_more: true, total: 124 });
    render(<Facts />);
    await screen.findByText("fact f1");
    expect(document.querySelector(".filterbar .count")!.textContent).toBe("124 facts, newest first");
    expect(document.querySelector(".filterbar .count b")!.textContent).toBe("124");
  });

  it.each([
    ["Status", "candidate", { status: "candidate" }, "status=candidate"],
    ["Status", "any", {}, "status=any"],
    ["Who gets it", "personal", { status: "active", scope: "personal" }, "level=personal"],
    ["Who gets it", "repo:acme/widgets", { status: "active", scope: "repo:acme/widgets" }, "level=repository&repo=acme%2Fwidgets"],
    ["Who gets it", "team:billing", { status: "active", scope: "team:billing" }, "level=team%3Abilling"],
    ["Who gets it", "global", { status: "active", scope: "global" }, "level=global"],
    ["Kind", "invariant", { status: "active", kind: "invariant" }, "kind=invariant"],
    ["Came from", "distilled", { status: "active", origin: "distilled" }, "origin=distilled"],
  ])("the %s menu set to %s goes into the request and the URL, and takes the tint", async (name, value, expected, search) => {
    render(<Facts />);
    await screen.findByRole("option", { name: "Repo: widgets" });
    await screen.findByRole("option", { name: "Team: Billing" });
    fireEvent.change(menu(name), { target: { value } });
    await waitFor(() => expect(Object.fromEntries(lastCall("/v1/facts"))).toEqual({ ...expected, limit: "50", offset: "0" }));
    expect(location.search).toBe(`?${search}`);
    expect(menu(name).className).toBe("menu set");
  });

  it("uses the plain words in the menus, keeping API values as option values", async () => {
    render(<Facts />);
    await screen.findByText("fact f1");
    const status = within(menu("Status"));
    expect(status.getAllByRole("option").map((o) => o.textContent)).toEqual(["Live", "Waiting for review", "Replaced", "Retired", "Any status"]);
    expect(status.getByRole("option", { name: "Waiting for review" }).getAttribute("value")).toBe("candidate");
    expect(within(menu("Kind")).getByRole("option", { name: "Must stay true" }).getAttribute("value")).toBe("invariant");
    expect(within(menu("Came from")).getByRole("option", { name: "Learned from a conversation" }).getAttribute("value")).toBe("distilled");
  });

  it.each([
    ["?level=repository&repo=acme/widgets", "Repo: widgets", { scope: "repo:acme/widgets" }],
    ["?level=repository", "For anyone", {}],
    ["?repo=acme/widgets", "Repo: widgets", { scope: "repo:acme/widgets" }],
  ])("reads %s from the URL", async (search, label, expected) => {
    history.replaceState(null, "", `/facts${search}`);
    render(<Facts />);
    await screen.findByText("fact f1");
    expect(Object.fromEntries(lastCall("/v1/facts"))).toEqual({ ...expected, status: "active", limit: "50", offset: "0" });
    await waitFor(() => expect(picked("Who gets it")).toBe(label));
  });

  it("keeps the filters in the URL across a remount", async () => {
    const { unmount } = render(<Facts />);
    await screen.findByText("fact f1");
    fireEvent.change(menu("Who gets it"), { target: { value: "personal" } });
    fireEvent.change(menu("Came from"), { target: { value: "authored" } });
    unmount();
    fetchMock.mockClear();

    render(<Facts />);
    await screen.findByText("fact f1");
    expect(Object.fromEntries(lastCall("/v1/facts"))).toEqual({ scope: "personal", status: "active", origin: "authored", limit: "50", offset: "0" });
    expect(menu("Who gets it").value).toBe("personal");
    expect(menu("Came from").value).toBe("authored");
  });

  it("shows each fact as one link: text, who gets it, kind and when, and how often it was used", async () => {
    listPage = () => ({
      facts: [
        fact("t1", { text: "team fact", kind: "convention", scope: "team:billing", level: "team", team: "billing", team_name: "Billing", use_count: 5 }),
        fact("p1", { text: "my fact", scope: "personal:u1", level: "personal", status: "candidate", use_count: 0 }),
      ],
      has_more: false,
      total: 2,
    });
    render(<Facts />);
    await screen.findByText("team fact");
    const t1 = screen.getByRole("link", { name: /^team fact/ });
    expect(t1.className).toBe("fact-row");
    expect(t1.getAttribute("href")).toBe("/facts/t1");
    expect(within(t1).getByText("Team: Billing").className).toBe("ui-badge who");
    expect(t1.querySelector(".meta")!.textContent).toMatch(/^Team: Billing Convention, .+ Used 5 times$/);
    expect(t1.querySelector(".used")!.textContent).toBe("Used 5 times");
    const time = t1.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe("2026-10-01T12:00:00Z");
    expect(time.textContent).not.toMatch(/2026-10-01/);

    const p1 = screen.getByRole("link", { name: /^my fact/ });
    expect(within(p1).getByText("Just me")).toBeTruthy();
    expect(p1.querySelector(".meta")!.textContent).toMatch(/Pitfall, Waiting for review, /);
    expect(p1.querySelector(".used")!.textContent).toBe("Not used yet");
  });

  it("says what would appear when nothing matches", async () => {
    listPage = () => ({ facts: [], has_more: false, total: 0 });
    render(<Facts />);
    expect(await screen.findByRole("heading", { name: "Nothing matches these filters" })).toBeTruthy();
    expect(document.querySelector(".filterbar .count")!.textContent).toBe("0 facts, newest first");
  });

  it("pages by has_more", async () => {
    listPage = (offset) => ({ facts: [fact(`p${offset}`)], has_more: offset === 0, total: 51 });
    render(<Facts />);
    await screen.findByText("fact p0");
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    const prev = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    expect(next.className).toBe("btn quiet");
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(screen.getByText("Page 1")).toBeTruthy();

    fireEvent.click(next);
    await screen.findByText("fact p50");
    expect(lastCall("/v1/facts").get("offset")).toBe("50");
    expect(new URLSearchParams(location.search).get("page")).toBe("1");
    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(next.disabled).toBe(true);

    fireEvent.click(prev);
    await screen.findByText("fact p0");
    expect(lastCall("/v1/facts").get("offset")).toBe("0");
    expect(location.search).toBe("");
  });

  it("searches on Enter, filters the hits here, counts them, and has no pages or Used line", async () => {
    searchHits = [
      fact("s1", { text: "kept hit", scope: "repo:acme/widgets", status: "candidate" }),
      fact("s2", { text: "wrong status", scope: "repo:acme/widgets", status: "active" }),
      fact("s3", { text: "wrong scope", scope: "global", status: "candidate" }),
    ];
    render(<Facts />);
    await screen.findByRole("option", { name: "Repo: widgets" });
    fireEvent.change(menu("Who gets it"), { target: { value: "repo:acme/widgets" } });
    fireEvent.change(menu("Status"), { target: { value: "candidate" } });
    search(" retry budget ");

    await screen.findByText("kept hit");
    expect(Object.fromEntries(lastCall("/v1/search"))).toEqual({
      q: "retry budget", source: "fact", k: "100", include_candidates: "true", repo_key: "acme/widgets",
    });
    expect(screen.queryByText("wrong status")).toBeNull();
    expect(screen.queryByText("wrong scope")).toBeNull();
    expect(document.querySelector(".filterbar .count")!.textContent).toBe("1 match, best first");
    expect(screen.getByRole("note").textContent).toBe("At most 100 matches are shown.");
    expect(screen.getByRole("link", { name: /^kept hit/ }).querySelector(".used")).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(new URLSearchParams(location.search).get("q")).toBe("retry budget");
  });

  it("search keeps only live hits by default, any status with Any status, and applies the other menus here", async () => {
    searchHits = [
      fact("s1", { text: "kept hit", scope: "personal:u1", origin: "authored", kind: "gotcha" }),
      fact("s2", { text: "wrong origin", scope: "personal:u1", origin: "distilled", kind: "gotcha" }),
      fact("s3", { text: "wrong kind", scope: "personal:u1", origin: "authored", kind: "decision" }),
      fact("s4", { text: "wrong scope", scope: "global", origin: "authored", kind: "gotcha" }),
      fact("s5", { text: "waiting hit", scope: "personal:u1", origin: "authored", kind: "gotcha", status: "candidate" }),
    ];
    render(<Facts />);
    await screen.findByText("fact f1");
    fireEvent.change(menu("Who gets it"), { target: { value: "personal" } });
    fireEvent.change(menu("Came from"), { target: { value: "authored" } });
    fireEvent.change(menu("Kind"), { target: { value: "gotcha" } });
    search("retry budget");

    await screen.findByText("kept hit");
    expect(screen.queryByText("wrong origin")).toBeNull();
    expect(screen.queryByText("wrong kind")).toBeNull();
    expect(screen.queryByText("wrong scope")).toBeNull();
    expect(screen.queryByText("waiting hit")).toBeNull();

    fireEvent.change(menu("Status"), { target: { value: "any" } });
    expect(await screen.findByText("waiting hit")).toBeTruthy();
    expect(document.querySelector(".filterbar .count")!.textContent).toBe("2 matches, best first");
  });
});

describe("fact detail", () => {
  it("opens in the path, keeps the query, and shows anchors, chain and reviews", async () => {
    history.replaceState(null, "", "/facts?level=global");
    render(<Facts />);
    fireEvent.click(await screen.findByRole("link", { name: /^fact f1/ }));
    expect(location.pathname + location.search).toBe("/facts/f1?level=global");

    const panel = await screen.findByRole("complementary", { name: "Fact detail" });
    await within(panel).findByText("the open fact");
    expect(within(panel).getByRole("heading", { name: "Where this comes from" })).toBeTruthy();
    expect(within(panel).getByText("Source changed").className).toMatch(/badge verify-drifted/);
    expect(within(panel).getByText("Still matches").className).toMatch(/badge verify-verified/);
    expect(within(panel).getByText("@abc123")).toBeTruthy();
    expect(within(panel).getByText("Pitfall")).toBeTruthy();
    expect(within(panel).getByText("Live")).toBeTruthy();
    expect(within(panel).getByText("Written by a person")).toBeTruthy();
    expect(within(panel).getByText("(Replaced)")).toBeTruthy();
    const details = panel.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Details");
    expect(within(details).getByText("f1")).toBeTruthy();
    expect(within(details).getByText("u1")).toBeTruthy();
    expect(within(panel).getByText("quote changed")).toBeTruthy();
    expect(within(panel).getByText("Now found at line 12.")).toBeTruthy();
    const links = within(panel).getAllByRole("link", { name: "View on GitHub" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["https://github.com/acme/widgets/blob/abc123/src/a.ts#L10-L14"]);
    expect(within(panel).getByText("tightened wording")).toBeTruthy();
    expect(within(panel).getByText("fix")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("link", { name: "the older fact" }));
    expect(location.pathname + location.search).toBe("/facts/f0?level=global");
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
