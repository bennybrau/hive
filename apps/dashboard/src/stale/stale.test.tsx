import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../Shell";
import { Stale, type StaleFact } from "./Stale";

function fact(id: string, over: Partial<StaleFact> = {}): StaleFact {
  return {
    id,
    text: `stale ${id}`,
    kind: "decision",
    scope: "global",
    locus: [],
    origin: "authored",
    status: "active",
    status_note: null,
    author_user_id: "u1",
    recorded_at: "2025-01-01T12:00:00Z",
    use_count: 0,
    cite_count: 0,
    last_used_at: null,
    pinned: false,
    idle_days: 90,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let page: { facts: StaleFact[]; has_more: boolean; stale_days: number };
let curateStatus: number;
let curateBody: unknown;
let repoKeys: string[];
let anchors: { repo_key: string | null }[];

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/facts/stale") return json(page);
  if (url.pathname === "/v1/repo-keys") return json({ repo_keys: repoKeys });
  if (url.pathname === "/v1/teams") return json({ teams: [{ key: "billing", name: "Billing", created_at: "", members: [], repos: [] }] });
  if (url.pathname === "/v1/teams/mine") return json({ teams: [] });
  if (/^\/v1\/facts\/[^/]+\/curate$/.test(url.pathname)) {
    return curateStatus === 200 ? json(curateBody) : json({ error: "fact is not active" }, curateStatus);
  }
  if (/^\/v1\/facts\/[^/]+$/.test(url.pathname)) return json({ fact: {}, anchors, reviews: [] });
  return json({ error: "not found" }, 404);
});

/** The curate POSTs made so far, as [fact id, body]. */
function posts(): [string, unknown][] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([u, init]) => [/\/v1\/facts\/([^/]+)\/curate/.exec(String(u))![1]!, JSON.parse(String(init!.body))]);
}

const card = () => screen.getByRole("article", { name: "Fact" });
/** The card's fact id and its "Fact n of N" line. */
const at = () => [card().dataset.id, card().querySelector(".pos .label")!.textContent];
const decide = () => within(card()).getByRole("group", { name: "Decide" });
const click = (name: string) => fireEvent.click(within(card()).getByRole("button", { name }));
const buttons = () => within(decide()).getAllByRole("button").map((b) => [b.textContent, b.classList.contains("primary")]);
const primaries = () => document.querySelectorAll("button.primary").length;

beforeEach(() => {
  page = { facts: [fact("f1"), fact("f2"), fact("f3")], has_more: false, stale_days: 60 };
  curateStatus = 200;
  curateBody = { fact: {}, new_fact: null };
  repoKeys = ["gh/o/a", "gh/o/b", "local"];
  anchors = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  render(<Stale role="curator" />);
  await screen.findByText("stale f1", { selector: ".proposed" });
}

describe("out of date facts", () => {
  it("shows one card at a time, with the count and stale_days in the lede, and ‹ › to move", async () => {
    await open();
    expect(new URL(String(fetchMock.mock.calls[0]![0]), "http://hive").search).toBe("?limit=100");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Out of date");
    expect(document.querySelector(".lede")!.textContent).toBe("3 facts nobody has used in 60 days.");
    expect(screen.queryByRole("list")).toBeNull();
    expect(at()).toEqual(["f1", "Fact 1 of 3"]);
    expect((within(card()).getByRole("button", { name: "Previous fact" }) as HTMLButtonElement).disabled).toBe(true);
    click("Next fact");
    click("Next fact");
    expect(at()).toEqual(["f3", "Fact 3 of 3"]);
    expect((within(card()).getByRole("button", { name: "Next fact" }) as HTMLButtonElement).disabled).toBe(true);
    click("Previous fact");
    expect(at()).toEqual(["f2", "Fact 2 of 3"]);
    expect(within(card()).getByText("stale f2", { selector: ".proposed" })).toBeTruthy();
  });

  it("says why: when it was last used, or that it never was since it was added", async () => {
    const used = new Date(Date.now() - 3 * 86400_000).toISOString();
    page = { facts: [fact("f1", { last_used_at: used }), fact("f2")], has_more: false, stale_days: 45 };
    await open();
    const why = () => within(card()).getByRole("region", { name: "Why Hive thinks so" });
    expect(why().querySelector("p")!.textContent).toBe("Nobody has used it in 45 days. Last used 3 days ago.");
    expect(why().querySelector("time")!.getAttribute("dateTime")).toBe(used);
    expect(why().querySelector("time")!.getAttribute("title")).toMatch(/\d{4}/);
    click("Next fact");
    expect(why().querySelector("p")!.textContent).toBe("Never used since it was added Jan 1, 2025.");
    expect(why().querySelector("time")!.getAttribute("dateTime")).toBe("2025-01-01T12:00:00Z");
    expect(why().querySelector("time")!.getAttribute("title")).toMatch(/January 1, 2025/);
  });

  it("keeps uses, cites and the id under Details", async () => {
    page.facts[0] = fact("f1", { use_count: 3, cite_count: 1 });
    await open();
    const details = within(card()).getByText("Details").closest("details")!;
    expect(details.open).toBe(false);
    const dl = [...details.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]);
    expect(dl).toEqual([
      ["Uses", "3"],
      ["Cites", "1"],
      ["Id", "f1"],
    ]);
  });

  it("has one primary button in each state: Keep, Move to, Save fix", async () => {
    await open();
    expect(buttons()).toEqual([
      ["Keep", true],
      ["Move…", false],
      ["Retire", false],
      ["Edit…", false],
      ["Pin", false],
    ]);
    expect(decide().querySelectorAll("button.big").length).toBe(3);
    expect(within(decide()).getByRole("button", { name: "Edit…" }).classList.contains("quiet")).toBe(true);
    expect(within(decide()).getByRole("button", { name: "Pin" }).classList.contains("quiet")).toBe(true);
    expect(primaries()).toBe(1);

    click("Move…");
    expect(buttons()).toEqual([
      ["Move to Everyone", true],
      ["Cancel", false],
    ]);
    expect(primaries()).toBe(1);
    click("Cancel");

    click("Edit…");
    expect(buttons()).toEqual([
      ["Save fix", true],
      ["Cancel", false],
    ]);
    expect(primaries()).toBe(1);
    click("Cancel");

    click("Retire");
    expect(buttons()).toEqual([
      ["Retire fact", false],
      ["Cancel", false],
    ]);
    expect(within(decide()).getByRole("button", { name: "Retire fact" }).classList.contains("danger")).toBe(true);
  });

  it("Keep and Pin post at once and the card goes, showing the next", async () => {
    await open();
    click("Keep");
    await waitFor(() => expect(at()).toEqual(["f2", "Fact 1 of 2"]));
    click("Pin");
    await waitFor(() => expect(at()).toEqual(["f3", "Fact 1 of 1"]));
    expect(posts()).toEqual([
      ["f1", { action: "keep" }],
      ["f2", { action: "pin" }],
    ]);
  });

  it("Edit… edits the text; Enter saves, Esc cancels, and short text isn't sent", async () => {
    await open();
    click("Edit…");
    const box = () => screen.getByLabelText("Edit the fact") as HTMLTextAreaElement;
    expect(box().value).toBe("stale f1");
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByLabelText("Edit the fact")).toBeNull();

    click("Edit…");
    fireEvent.change(box(), { target: { value: " ab " } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(posts()).toEqual([]);
    expect((within(decide()).getByRole("button", { name: "Save fix" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "  stale f1, fixed  " } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(at()).toEqual(["f2", "Fact 1 of 2"]));
    expect(posts()).toEqual([["f1", { action: "fix", new_text: "stale f1, fixed" }]]);
  });

  it("Retire asks to confirm, with an optional note", async () => {
    await open();
    click("Retire");
    expect(posts()).toEqual([]);
    expect(screen.getByLabelText("Why retire it? (optional)")).toBeTruthy();
    click("Cancel");
    expect(screen.queryByLabelText(/Why retire it/)).toBeNull();
    expect(at()).toEqual(["f1", "Fact 1 of 3"]);

    click("Retire");
    click("Retire fact");
    await waitFor(() => expect(at()).toEqual(["f2", "Fact 1 of 2"]));
    click("Retire");
    fireEvent.change(screen.getByLabelText(/Why retire it/), { target: { value: " moved to v2 " } });
    fireEvent.keyDown(screen.getByLabelText(/Why retire it/), { key: "Enter" });
    await waitFor(() => expect(at()).toEqual(["f3", "Fact 1 of 1"]));
    expect(posts()).toEqual([
      ["f1", { action: "retire" }],
      ["f2", { action: "retire", note: "moved to v2" }],
    ]);
  });

  it("Move… offers every level, Just me included, and sends the pick from Another repo…", async () => {
    anchors = [{ repo_key: "gh/o/a" }];
    await open();
    click("Move…");
    const who = within(within(card()).getByRole("group", { name: "Who should get this?" }));
    await who.findByRole("radio", { name: "Repo: a" });
    await who.findByRole("option", { name: "local" });
    expect(who.getAllByRole("radio").map((r) => card().querySelector(`label[for="${r.id}"]`)!.textContent)).toEqual([
      "Everyone (current)",
      "Repo: a",
      "Another repo…",
      "Team: Billing",
      "Just me",
    ]);
    expect(within(decide()).getByRole("button", { name: "Move to Everyone" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(who.getByLabelText("Another repo"), { target: { value: "local" } });
    click("Move to Repo: local");
    await waitFor(() => expect(at()).toEqual(["f2", "Fact 1 of 2"]));
    expect(posts()).toEqual([["f1", { action: "move", scope: "repo:local" }]]);
  });

  it("a level picked from Change… turns the footer into Move to, with this repo offered", async () => {
    anchors = [{ repo_key: "gh/o/a" }];
    await open();
    click("Change…");
    fireEvent.click(await within(card()).findByRole("radio", { name: "Repo: a" }));
    expect(buttons()).toEqual([
      ["Move to Repo: a", true],
      ["Cancel", false],
    ]);
    click("Cancel");
    expect(buttons()[0]).toEqual(["Keep", true]);
    fireEvent.click(within(card()).getByRole("radio", { name: "Repo: a" }));
    click("Move to Repo: a");
    await waitFor(() => expect(at()).toEqual(["f2", "Fact 1 of 2"]));
    expect(posts()).toEqual([["f1", { action: "move", scope: "repo:gh/o/a" }]]);
  });

  it("Just me sends personal, and a merge is reported", async () => {
    curateBody = { fact: {}, new_fact: null, merged_into: { id: "7a8b9c0d-aaaa-bbbb-cccc-000000000001", text: "the same, said before" } };
    await open();
    click("Move…");
    fireEvent.click(await within(card()).findByRole("radio", { name: "Just me" }));
    click("Move to Just me");
    expect((await screen.findByRole("status")).textContent).toBe("Moved, merged into fact 7a8b9c0d: the same, said before");
    expect(posts()).toEqual([["f1", { action: "move", scope: "personal" }]]);
    expect(at()).toEqual(["f2", "Fact 1 of 2"]);
  });

  it("a personal fact isn't offered Just me again", async () => {
    page.facts[0] = fact("f1", { scope: "personal:u1" });
    await open();
    click("Move…");
    await within(card()).findByRole("radio", { name: "Team: Billing" });
    expect(within(card()).getAllByRole("radio", { name: /Just me/ }).map((r) => card().querySelector(`label[for="${r.id}"]`)!.textContent)).toEqual([
      "Just me (current)",
    ]);
  });

  it("disables the buttons while a request is in flight", async () => {
    let answer!: (r: Response) => void;
    await open();
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    click("Keep");
    for (const name of ["Keep", "Move…", "Retire", "Edit…", "Pin"]) {
      expect((within(decide()).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    answer(json({ fact: {}, new_fact: null }));
    await waitFor(() => expect(at()).toEqual(["f2", "Fact 1 of 2"]));
    expect((within(decide()).getByRole("button", { name: "Keep" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a failed curate keeps the card and shows the hive's error", async () => {
    curateStatus = 409;
    await open();
    click("Keep");
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save that: fact is not active (409).");
    expect(at()).toEqual(["f1", "Fact 1 of 3"]);
    expect((within(decide()).getByRole("button", { name: "Keep" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when nothing is out of date, using stale_days", async () => {
    page = { facts: [], has_more: false, stale_days: 30 };
    render(<Stale role="curator" />);
    expect((await screen.findByRole("heading", { name: "Nothing is out of date" })).tagName).toBe("H2");
    expect(screen.getByText(/A fact shows here/).textContent).toBe("A fact shows here when no agent has used it for 30 days.");
    expect(screen.queryByRole("article")).toBeNull();
    expect(document.querySelector(".lede")).toBeNull();
  });
  it("notes when only the first 100 are shown", async () => {
    page.has_more = true;
    await open();
    expect(screen.getByText(/first 100/)).toBeTruthy();
  });

  it("shows a load error", async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: "nope" }, 500));
    render(<Stale role="curator" />);
    expect((await screen.findByRole("alert")).textContent).toBe("The hive answered 500.");
  });

  it("members get a note, nothing is fetched, and the Shell has Review but no Stale link", () => {
    render(<Stale role="member" />);
    expect(screen.getByRole("note").textContent).toMatch(/curators only/);
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();

    const status = (role: "member" | "curator") => ({ version: "t", instance: { id: "i1", name: "x", user_id: "u1", role } });
    const { unmount } = render(<Shell status={status("member")} path="/facts">{null}</Shell>);
    expect(screen.queryByRole("link", { name: "Out of date" })).toBeNull();
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/review");
    unmount();
    render(<Shell status={status("curator")} path="/stale">{null}</Shell>);
    expect(screen.getByRole("link", { name: "Out of date" }).getAttribute("aria-current")).toBe("page");
  });
});
