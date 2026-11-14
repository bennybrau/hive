import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Facts } from "./Facts";
import type { Fact } from "./query";
import { RAW_VALUES } from "../words";

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
let detailOf: (id: string) => unknown;
let searchHits: Fact[];

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/repos") return json({ repos: [{ key: "acme/widgets" }] });
  if (url.pathname === "/v1/teams") return json({ teams: [TEAM] });
  if (url.pathname === "/v1/teams/mine") return json({ teams: [] });
  if (url.pathname === "/v1/search") return json({ mode: "hybrid", facts: searchHits, results: [] });
  if (url.pathname === "/v1/facts") return json(listPage(Number(url.searchParams.get("offset"))));
  if (url.pathname.startsWith("/v1/facts/")) {
    return json(detailOf(url.pathname.slice("/v1/facts/".length)));
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
  detailOf = (id) => (id === "f1" ? DETAIL : { ...DETAIL, fact: fact(id, { text: `detail ${id}` }), supersedes: [] });
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
    for (const m of screen.getAllByRole("combobox")) expect(m.parentElement!.className).toBe("menu");
    // Each menu is drawn as its current value, so it is only as wide as that word.
    expect([...document.querySelectorAll(".menu .now")].map((n) => n.textContent)).toEqual(["Live", "For anyone", "Any kind", "From anywhere"]);
    expect(screen.getByText("Search facts").tagName).toBe("LABEL");
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
    expect(menu(name).parentElement!.className).toBe("menu set");
    expect(menu(name).parentElement!.querySelector(".now")!.textContent).toBe(picked(name));
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

const HOURS_AGO = new Date(Date.now() - 2 * 3600_000).toISOString();

/** An anchor on something a person said (no file). */
const said = (id: string, over: Partial<(typeof DETAIL.anchors)[number]> & { source?: unknown }) => ({
  ...DETAIL.anchors[1]!, id, repo_key: null, commit_sha: null, path: null, line_start: null, line_end: null, found_line: null,
  episode_id: `ep-${id}`, quote: "we always use Postgres", verify_status: "verified", source: null, ...over,
});

const pane = () => screen.findByRole("complementary", { name: "Selected fact" });

async function openPane(detail: object, url = "/facts/f1") {
  detailOf = () => detail;
  history.replaceState(null, "", url);
  render(<Facts />);
  const p = await pane();
  await within(p).findByText((detail as typeof DETAIL).fact.text);
  return p;
}

describe("fact detail", () => {
  it("opens in the path, keeps the query, and shows the file anchors, chain and history", async () => {
    history.replaceState(null, "", "/facts?level=global");
    render(<Facts />);
    fireEvent.click(await screen.findByRole("link", { name: /^fact f1/ }));
    expect(location.pathname + location.search).toBe("/facts/f1?level=global");
    expect(history.state).toEqual({ fromList: true });

    const panel = await pane();
    await within(panel).findByText("the open fact");
    expect(document.querySelector("main")!.className).toBe("page kn view-fact");
    // The pane sits beside the rows only: the search box and the filter line span the page above both.
    const split = document.querySelector(".kn-split")!;
    expect(split.querySelector("aside")).toBeTruthy();
    expect(split.querySelector(".kn-list")).toBeTruthy();
    expect(split.querySelector(".filterbar, [role=search]")).toBeNull();
    const files = within(panel).getByRole("list", { name: "Where this comes from" });
    expect(within(files).getByText("Source changed").className).toMatch(/badge verify-drifted/);
    expect(within(files).getByText("Still matches").className).toMatch(/badge verify-verified/);
    expect(within(files).getByText("@abc123")).toBeTruthy();
    expect(within(files).getByText("quote changed")).toBeTruthy();
    expect(within(files).getByText("Now found at line 12.")).toBeTruthy();
    expect(within(files).getByText("const a = 1;").className).toBe("quote");
    const links = within(panel).getAllByRole("link", { name: "View on GitHub" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["https://github.com/acme/widgets/blob/abc123/src/a.ts#L10-L14"]);
    expect([...panel.querySelectorAll(".pane-top .ui-badge")].map((b) => b.textContent)).toEqual(["Repo: widgets", "Pitfall", "Live"]);
    expect(within(panel).getByRole("heading", { name: "Replaces" })).toBeTruthy();
    expect(within(panel).getByText("(Replaced)")).toBeTruthy();

    const details = panel.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Details");
    expect(within(details).getByText("f1")).toBeTruthy();
    expect(within(details).getByText("u1")).toBeTruthy();
    expect(within(details).getByText("tightened wording")).toBeTruthy();
    expect(details.querySelector(".history li")!.textContent).toMatch(/^Approved with a fix by curator1, October 3, 2026/);

    fireEvent.click(within(panel).getByRole("link", { name: "the older fact" }));
    expect(location.pathname + location.search).toBe("/facts/f0?level=global");
    expect(await within(panel).findByText("detail f0")).toBeTruthy();
  });

  it("opens straight from a /facts/<id> URL", async () => {
    history.replaceState(null, "", "/facts/f1");
    render(<Facts />);
    expect(await screen.findByText("the open fact")).toBeTruthy();
  });

  it("lays the pane out in order: badges and Close, the fact, what was said, the files, the plain lines, the chain, Details", async () => {
    const p = await openPane({ ...DETAIL, anchors: [DETAIL.anchors[0], said("q1", {})] });
    expect([...p.children].map((c) => c.className || c.tagName)).toEqual(["pane-top", "bigfact", "said", "files", "kv", "chain", "more"]);
    expect(within(p.querySelector(".pane-top") as HTMLElement).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(within(p.querySelector(".kv") as HTMLElement).getAllByRole("term").map((t) => t.textContent)).toEqual(["Who gets it", "Written"]);
    expect(p.querySelector(".kv dd")!.textContent).toBe("Agents working in the widgets repo.");
  });

  it("says who said a quote, where and when, and whether it still matches", async () => {
    const p = await openPane({
      ...DETAIL,
      anchors: [said("q1", { source: { kind: "asf_dialog", author: "Jon", where: "factory_plan_note", at: HOURS_AGO } })],
    });
    const fig = p.querySelector("figure.said")!;
    expect(fig.querySelector("blockquote")!.textContent).toBe("we always use Postgres");
    expect([...fig.querySelectorAll("figcaption > span")].map((s) => s.textContent)).toEqual([
      "Jon, in a factory plan approval, 2 hours ago",
      "Still matches",
    ]);
  });

  it("shows a quote said in two conversations once, and lists both conversations in Details", async () => {
    const p = await openPane({
      ...DETAIL,
      anchors: [said("q1", {}), said("q2", { source: { kind: "turn", author: "ana", where: "conversation", at: HOURS_AGO } }), said("q3", { quote: "and Redis for queues" })],
    });
    const figs = [...p.querySelectorAll("figure.said")];
    expect(figs.map((f) => f.querySelector("blockquote")!.textContent)).toEqual(["we always use Postgres", "and Redis for queues"]);
    expect(figs[0]!.querySelector("figcaption")!.textContent).toBe("Ana, in a conversation with Hermes, 2 hours agoStill matches");
    const details = p.querySelector("details")!;
    expect(within(details).getByText("Conversations")).toBeTruthy();
    expect([...details.querySelectorAll("dd code")].map((c) => c.textContent)).toEqual(["f1", "ep-q1", "ep-q2", "ep-q3"]);
  });

  it("without a source a quote shows with its check alone", async () => {
    const p = await openPane({ ...DETAIL, anchors: [said("q1", { verify_status: "unverified" })] });
    const caption = p.querySelector("figure.said figcaption")!;
    expect([...caption.children].map((c) => c.textContent)).toEqual(["Not checked yet"]);
    expect(p.querySelector(".files")).toBeNull();
  });

  it.each([
    ["distilled", "Approved", "By Curator2, 2 hours ago"],
    ["authored", "Written", "By U1, Oct 1"],
    ["ingested", null, null],
  ])("a fact from origin %s has its %s line", async (origin, term, line) => {
    const reviews = [
      { action: "approve", note: null, new_text: null, reviewer_user_id: "curator1", created_at: "2026-10-02T00:00:00Z" },
      { action: "fix", note: null, new_text: "x", reviewer_user_id: "curator2", created_at: HOURS_AGO },
      { action: "pin", note: null, new_text: null, reviewer_user_id: "curator3", created_at: HOURS_AGO },
    ];
    const f = fact("f1", { text: "the open fact", origin, recorded_at: `${new Date().getFullYear()}-10-01T12:00:00Z`, use_count: 5, last_used_at: HOURS_AGO });
    const p = await openPane({ ...DETAIL, fact: f, reviews });
    const kv = p.querySelector(".kv")!;
    const terms = [...kv.querySelectorAll(":scope > dt")].map((t) => t.textContent);
    expect(terms).toEqual(["Who gets it", "Used", ...(term ? [term] : [])]);
    expect(kv.querySelectorAll(":scope > dd")[1]!.textContent).toBe("5 times, last 2 hours ago");
    if (line) expect(kv.querySelectorAll(":scope > dd")[2]!.textContent).toBe(line);
  });

  it("says why a retired fact was retired", async () => {
    const p = await openPane({ ...DETAIL, fact: fact("f1", { text: "the open fact", origin: "ingested", status: "retracted", status_note: "Wrong since v2" }) });
    const kv = p.querySelector(".kv")!;
    expect([...kv.querySelectorAll("dt")].map((t) => t.textContent)).toEqual(["Who gets it", "Retired"]);
    expect(kv.querySelectorAll("dd")[1]!.textContent).toBe("Wrong since v2");
  });

  it("shows no raw API value and no raw review action", async () => {
    const actions = ["approve", "fix", "reject", "keep", "retire", "pin", "unpin", "move"];
    const p = await openPane({
      ...DETAIL,
      fact: fact("f1", { text: "the open fact", origin: "distilled", status: "superseded", status_note: "newer one", use_count: 0, last_used_at: null }),
      anchors: [...DETAIL.anchors, said("q1", { verify_status: "unverifiable_here", source: { kind: "turn", author: null, where: "other", at: HOURS_AGO } })],
      reviews: actions.map((action) => ({ action, note: null, new_text: null, reviewer_user_id: "c1", created_at: HOURS_AGO })),
      superseded_by: [{ id: "f9", text: "the newer fact", status: "active", recorded_at: HOURS_AGO }],
    });
    const text = p.textContent!;
    // "fix" is fine inside "Approved with a fix"; the history lines are checked whole below.
    for (const raw of [...RAW_VALUES, ...actions.filter((a) => a !== "fix"), "turn"]) {
      expect(text).not.toMatch(new RegExp(`\\b${raw}\\b`));
    }
    expect([...p.querySelectorAll(".history li")].map((li) => li.textContent!.split(" by ")[0])).toEqual([
      "Approved", "Approved with a fix", "Rejected", "Kept", "Retired", "Pinned", "Unpinned", "Moved",
    ]);
  });

  it("Escape and Close put focus back on the fact's row", async () => {
    render(<Facts />);
    await screen.findByText("fact f2");
    fireEvent.click(screen.getByRole("link", { name: /^fact f2/ }));
    await within(await pane()).findByText("detail f2");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(location.pathname).toBe("/facts");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(rows()[1]);

    fireEvent.click(screen.getByRole("link", { name: /^fact f3/ }));
    const p = await pane();
    await within(p).findByText("detail f3");
    fireEvent.click(within(p).getByRole("button", { name: "Close" }));
    expect(location.pathname).toBe("/facts");
    expect(document.querySelector("main")!.className).toBe("page kn no-fact");
    expect(document.activeElement).toBe(rows()[2]);
  });

  it("the back link goes to the list with the same filters, and focus returns to the row", async () => {
    history.replaceState(null, "", "/facts/f2?level=personal&kind=gotcha");
    render(<Facts />);
    await within(await pane()).findByText("detail f2");
    const back = screen.getByRole("link", { name: "Facts" });
    expect(back.getAttribute("href")).toBe("/facts?level=personal&kind=gotcha");
    const len = history.length;
    fireEvent.click(back);
    expect(location.pathname + location.search).toBe("/facts?level=personal&kind=gotcha");
    expect(history.length).toBe(len + 1);
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
  });

  it("the back link steps back in history when the fact was opened from the list", async () => {
    render(<Facts />);
    await screen.findByText("fact f1");
    fireEvent.click(screen.getByRole("link", { name: /^fact f2/ }));
    await within(await pane()).findByText("detail f2");
    const backSpy = vi.spyOn(history, "back");
    const len = history.length;
    fireEvent.click(screen.getByRole("link", { name: "Facts" }));
    expect(backSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(location.pathname).toBe("/facts"));
    expect(history.length).toBe(len);
    await waitFor(() => expect(document.activeElement).toBe(rows()[1]));
    backSpy.mockRestore();
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
