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

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/facts/stale") return json(page);
  if (/^\/v1\/facts\/[^/]+\/curate$/.test(url.pathname)) {
    return curateStatus === 200 ? json({ fact: {}, new_fact: null }) : json({ error: "fact is not active" }, curateStatus);
  }
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
    expect(rows()[0]!.querySelector(".meta")!.textContent).toBe("gotcha in repo:gh/o/a, idle 400 days");
    const dl = [...panel().querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]);
    expect(dl).toEqual([
      ["Kind", "gotcha"],
      ["Scope", "repo:gh/o/a"],
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
