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

const rows = () => within(screen.getByRole("list", { name: "Stale facts" })).getAllByRole("listitem");
const ids = () => rows().map((r) => r.dataset.id);
const panel = () => screen.getByRole("complementary", { name: "Fact" });
const click = (name: string) => fireEvent.click(within(panel()).getByRole("button", { name }));

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
  await screen.findByText("stale f1", { selector: ".text" });
}

describe("stale facts", () => {
  it("lists stale facts with their use, idle time and last use", async () => {
    page.facts[0] = fact("f1", { kind: "gotcha", scope: "repo:gh/o/a", idle_days: 400, use_count: 3, cite_count: 1, last_used_at: new Date(Date.now() - 3 * 86400_000).toISOString() });
    await open();
    expect(new URL(String(fetchMock.mock.calls[0]![0]), "http://hive").search).toBe("?limit=100");
    expect(screen.getByText(/unused for over/).textContent).toBe("3 unused for over 60 days.");
    expect(ids()).toEqual(["f1", "f2", "f3"]);
    expect(rows()[0]!.querySelector(".meta")!.textContent).toBe("gotcha in Repo: a, idle 400 days");
    const dl = [...panel().querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]);
    expect(dl).toEqual([
      ["Kind", "gotcha"],
      ["Level", "Repo: a"],
      ["Idle", "400 days"],
      ["Uses", "3"],
      ["Cites", "1"],
      ["Last used", "3 days ago"],
    ]);
    fireEvent.click(rows()[1]!);
    expect(panel().querySelector(".fact-text")!.textContent).toBe("stale f2");
    expect(within(panel()).getByText("never")).toBeTruthy();
  });

  it("Keep and Pin post at once and the row goes, selecting the next", async () => {
    await open();
    click("Keep");
    await waitFor(() => expect(ids()).toEqual(["f2", "f3"]));
    expect(rows()[0]!.getAttribute("aria-current")).toBe("true");
    click("Pin");
    await waitFor(() => expect(ids()).toEqual(["f3"]));
    expect(posts()).toEqual([
      ["f1", { action: "keep" }],
      ["f2", { action: "pin" }],
    ]);
  });

  it("Fix edits the text; Enter saves, Esc cancels, and short text isn't sent", async () => {
    await open();
    click("Fix");
    const box = screen.getByLabelText("Fixed text") as HTMLTextAreaElement;
    expect(box.value).toBe("stale f1");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByLabelText("Fixed text")).toBeNull();

    click("Fix");
    fireEvent.change(screen.getByLabelText("Fixed text"), { target: { value: " ab " } });
    fireEvent.keyDown(screen.getByLabelText("Fixed text"), { key: "Enter" });
    expect(posts()).toEqual([]);
    fireEvent.change(screen.getByLabelText("Fixed text"), { target: { value: "  stale f1, fixed  " } });
    fireEvent.keyDown(screen.getByLabelText("Fixed text"), { key: "Enter" });
    await waitFor(() => expect(ids()).toEqual(["f2", "f3"]));
    expect(posts()).toEqual([["f1", { action: "fix", new_text: "stale f1, fixed" }]]);
  });

  it("Retire asks to confirm, with an optional note", async () => {
    await open();
    click("Retire");
    expect(posts()).toEqual([]);
    expect(screen.getByLabelText("Why retire it? (optional)")).toBeTruthy();
    click("Cancel");
    expect(screen.queryByLabelText(/Why retire it/)).toBeNull();
    expect(ids()).toEqual(["f1", "f2", "f3"]);

    click("Retire");
    click("Retire fact");
    await waitFor(() => expect(ids()).toEqual(["f2", "f3"]));
    click("Retire");
    fireEvent.change(screen.getByLabelText(/Why retire it/), { target: { value: " moved to v2 " } });
    click("Retire fact");
    await waitFor(() => expect(ids()).toEqual(["f3"]));
    expect(posts()).toEqual([
      ["f1", { action: "retire" }],
      ["f2", { action: "retire", note: "moved to v2" }],
    ]);
  });

  it("Move… offers every level, Just me included, and sends the pick from Another repo…", async () => {
    anchors = [{ repo_key: "gh/o/a" }];
    await open();
    click("Move…");
    const who = within(within(panel()).getByRole("group", { name: "Who should get this?" }));
    await who.findByRole("radio", { name: "Repo: a" });
    await who.findByRole("option", { name: "local" });
    expect(who.getAllByRole("radio").map((r) => panel().querySelector(`label[for="${r.id}"]`)!.textContent)).toEqual([
      "Everyone (current)",
      "Repo: a",
      "Another repo…",
      "Team: Billing",
      "Just me",
    ]);
    expect(within(panel()).getByRole("button", { name: "Move to Everyone" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(who.getByLabelText("Another repo"), { target: { value: "local" } });
    click("Move to Repo: local");
    await waitFor(() => expect(ids()).toEqual(["f2", "f3"]));
    expect(posts()).toEqual([["f1", { action: "move", scope: "repo:local" }]]);
  });

  it("Just me sends personal, and a merge is reported", async () => {
    curateBody = { fact: {}, new_fact: null, merged_into: { id: "7a8b9c0d-aaaa-bbbb-cccc-000000000001", text: "the same, said before" } };
    await open();
    click("Move…");
    fireEvent.click(await within(panel()).findByRole("radio", { name: "Just me" }));
    click("Move to Just me");
    expect((await screen.findByRole("status")).textContent).toBe("Moved, merged into fact 7a8b9c0d: the same, said before");
    expect(posts()).toEqual([["f1", { action: "move", scope: "personal" }]]);
    expect(ids()).toEqual(["f2", "f3"]);
  });

  it("a personal fact isn't offered Just me again", async () => {
    page.facts[0] = fact("f1", { scope: "personal:u1" });
    await open();
    click("Move…");
    await within(panel()).findByRole("radio", { name: "Team: Billing" });
    expect(within(panel()).getAllByRole("radio", { name: /Just me/ }).map((r) => panel().querySelector(`label[for="${r.id}"]`)!.textContent)).toEqual([
      "Just me (current)",
    ]);
  });

  it("disables the buttons while a request is in flight", async () => {
    let answer!: (r: Response) => void;
    await open();
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    click("Keep");
    for (const name of ["Keep", "Fix", "Retire", "Pin"]) {
      expect((within(panel()).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    answer(json({ fact: {}, new_fact: null }));
    await waitFor(() => expect(ids()).toEqual(["f2", "f3"]));
    expect((within(panel()).getByRole("button", { name: "Keep" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a failed curate keeps the row and shows the hive's error", async () => {
    curateStatus = 409;
    await open();
    click("Keep");
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save that: fact is not active (409).");
    expect(ids()).toEqual(["f1", "f2", "f3"]);
    expect((within(panel()).getByRole("button", { name: "Keep" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when nothing is stale, using stale_days", async () => {
    page = { facts: [], has_more: false, stale_days: 30 };
    render(<Stale role="curator" />);
    expect((await screen.findByText(/No facts unused/)).textContent).toBe("No facts unused for 30 days.");
    expect(screen.queryByRole("list", { name: "Stale facts" })).toBeNull();
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

  it("members get a note, nothing is fetched, and the Shell has no Stale link", () => {
    render(<Stale role="member" />);
    expect(screen.getByRole("note").textContent).toMatch(/curators only/);
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();

    const status = (role: "member" | "curator") => ({ version: "t", instance: { id: "i1", name: "x", user_id: "u1", role } });
    const { unmount } = render(<Shell status={status("member")} path="/facts">{null}</Shell>);
    expect(screen.queryByRole("link", { name: "Stale" })).toBeNull();
    unmount();
    render(<Shell status={status("curator")} path="/stale">{null}</Shell>);
    expect(screen.getByRole("link", { name: "Stale" }).getAttribute("aria-current")).toBe("page");
  });
});
