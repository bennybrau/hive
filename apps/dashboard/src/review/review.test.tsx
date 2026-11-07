import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Review, timeAgo, type Candidate } from "./Review";

function candidate(id: string, over: Partial<Candidate> = {}): Candidate {
  return {
    id,
    text: `candidate ${id}`,
    kind: "decision",
    scope: "global",
    locus: [],
    origin: "distilled",
    status: "candidate",
    status_note: null,
    author_user_id: "u1",
    recorded_at: "2026-10-01T12:00:00Z",
    supersedes: null,
    anchors: [],
    similar: [],
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let queue: { candidates: Candidate[]; last_distill_at: string | null };
let reviewStatus: number;

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/review/queue") return json(queue);
  if (/^\/v1\/facts\/[^/]+\/review$/.test(url.pathname)) {
    return reviewStatus === 200 ? json({ fact: {}, merged_into: null }) : json({ error: "fact is not a candidate" }, reviewStatus);
  }
  return json({ error: "not found" }, 404);
});

/** The review POSTs made so far, as [fact id, body]. */
function posts(): [string, unknown][] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([u, init]) => [/\/v1\/facts\/([^/]+)\/review/.exec(String(u))![1]!, JSON.parse(String(init!.body))]);
}

const rows = () => within(screen.getByRole("list", { name: "Candidates" })).getAllByRole("listitem");
const press = (key: string, target: Element | Window = window) => fireEvent.keyDown(target, { key });
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  queue = { candidates: [candidate("c1"), candidate("c2"), candidate("c3")], last_distill_at: null };
  reviewStatus = 200;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function open() {
  render(<Review role="curator" />);
  await screen.findByText("candidate c1", { selector: ".text" });
}

describe("review queue", () => {
  it("marks a candidate the user asked to remember, in its row and evidence", async () => {
    queue.candidates[0] = candidate("c1", { metadata: { asked: true } });
    await open();
    const badges = (el: Element) => [...el.querySelectorAll(".badge.asked")].map((b) => [b.className, b.textContent]);
    expect(badges(rows()[0]!)).toEqual([["badge asked", "asked to remember"]]);
    expect(badges(rows()[1]!)).toEqual([]);
    expect(badges(screen.getByRole("complementary", { name: "Evidence" }))).toEqual([["badge asked", "asked to remember"]]);
    press("j");
    expect(badges(screen.getByRole("complementary", { name: "Evidence" }))).toEqual([]);
  });

  it("lists candidates oldest first with the first one's evidence", async () => {
    queue.candidates[0] = candidate("c1", {
      anchors: [
        { id: "a1", episode_id: null, repo_key: "gh/o/a", path: "src/a.ts", line_start: 10, line_end: 14, quote: "const a = 1;", verify_status: "unverified", episode_snippet: null, exchange: null },
        { id: "a2", episode_id: "e1", repo_key: null, path: null, line_start: null, line_end: null, quote: "we agreed", verify_status: "unverified", episode_snippet: "so then we agreed on it", exchange: null },
      ],
      similar: [{ id: "s1", text: "an active twin", scope: "global", similarity: 0.912 }],
    });
    await open();
    expect(new URL(String(fetchMock.mock.calls[0]![0]), "http://hive").search).toBe("?limit=100");
    expect(rows().map((r) => r.dataset.id)).toEqual(["c1", "c2", "c3"]);
    expect(rows()[0]!.getAttribute("aria-current")).toBe("true");
    const panel = screen.getByRole("complementary", { name: "Evidence" });
    expect(within(panel).getByText("gh/o/a src/a.ts:L10–L14")).toBeTruthy();
    expect(within(panel).getByText("const a = 1;")).toBeTruthy();
    expect(within(panel).getByText("so then we agreed on it")).toBeTruthy();
    expect(within(panel).getByText("91%")).toBeTruthy();
  });

  it("shows the exchange a quote came from instead of its snippet; without one, the snippet", async () => {
    const anchor = { id: "a1", episode_id: "e1", repo_key: null, path: null, line_start: null, line_end: null, verify_status: "unverified" };
    queue.candidates[0] = candidate("c1", {
      anchors: [
        { ...anchor, quote: "we use Postgres", episode_snippet: "...no, we use Postgres...", exchange: { assistant: "I'll add Redis.", user: "no, we use Postgres" } },
        { ...anchor, id: "a2", quote: "billing", episode_snippet: "the billing snippet", exchange: null },
      ],
    });
    queue.candidates[1] = candidate("c2", {
      anchors: [{ ...anchor, quote: "deploys", episode_snippet: "we ship deploys on Fridays", exchange: { assistant: null, user: "deploys go out on Fridays" } }],
    });
    queue.candidates[2] = candidate("c3", {
      anchors: [{ ...anchor, quote: "kafka", episode_snippet: "assistant: use kafka", exchange: null }],
    });
    await open();
    const panel = () => screen.getByRole("complementary", { name: "Evidence" });
    const exchange = () => within(panel()).queryByRole("region", { name: "Exchange" });
    expect(within(exchange()!).getByText("bot said")).toBeTruthy();
    expect(within(exchange()!).getByText("I'll add Redis.")).toBeTruthy();
    expect(within(exchange()!).getByText("you said")).toBeTruthy();
    expect(within(exchange()!).getByText("no, we use Postgres")).toBeTruthy();
    expect(within(panel()).queryByText("...no, we use Postgres...")).toBeNull();
    expect(within(panel()).getByText("the billing snippet")).toBeTruthy();

    press("j");
    expect(within(exchange()!).queryByText("bot said")).toBeNull();
    expect(within(exchange()!).getByText("deploys go out on Fridays")).toBeTruthy();

    press("j");
    expect(exchange()).toBeNull();
    expect(within(panel()).getByText("assistant: use kafka")).toBeTruthy();
  });

  it("j and k move the current row and the evidence follows", async () => {
    await open();
    press("j");
    press("j");
    expect(rows()[2]!.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("complementary", { name: "Evidence" }).querySelector(".fact-text")!.textContent).toBe("candidate c3");
    press("j");
    expect(rows()[2]!.getAttribute("aria-current")).toBe("true");
    press("k");
    expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
  });

  it("a approves: the row goes, the toast offers Undo, and the POST goes out after 5 s", async () => {
    await open();
    press("a");
    expect(rows().map((r) => r.dataset.id)).toEqual(["c2", "c3"]);
    expect(screen.getByRole("status").textContent).toMatch(/^Approved·Undo$/);
    await tick(4900);
    expect(posts()).toEqual([]);
    await tick(200);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
    expect(screen.queryByRole("status")).toBeNull();
    await tick(10_000);
    expect(posts()).toHaveLength(1);
  });

  it("f opens the text for editing; Enter sends a fix with new_text", async () => {
    await open();
    press("j");
    press("f");
    const box = screen.getByLabelText("Fixed text") as HTMLTextAreaElement;
    expect(box.value).toBe("candidate c2");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: "  candidate c2, tightened  " } });
    press("Enter", box);
    expect(screen.getByRole("status").textContent).toMatch(/^Fixed/);
    await tick(5000);
    expect(posts()).toEqual([["c2", { action: "fix", new_text: "candidate c2, tightened" }]]);
  });

  it("Esc closes the fix box without deciding anything", async () => {
    await open();
    press("f");
    press("Escape", screen.getByLabelText("Fixed text"));
    expect(screen.queryByLabelText("Fixed text")).toBeNull();
    expect(rows()).toHaveLength(3);
    await tick(6000);
    expect(posts()).toEqual([]);
  });

  it("r asks for a note; Enter sends a reject with it", async () => {
    await open();
    press("r");
    const note = screen.getByLabelText(/Why reject it/);
    fireEvent.change(note, { target: { value: "not true any more" } });
    press("Enter", note);
    expect(screen.getByRole("status").textContent).toMatch(/^Rejected/);
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "reject", note: "not true any more" }]]);
  });

  it("keys typed in the fix box and the note do nothing", async () => {
    await open();
    press("f");
    const box = screen.getByLabelText("Fixed text");
    for (const k of ["j", "k", "a", "r", "f"]) press(k, box);
    expect(screen.getByLabelText("Fixed text")).toBeTruthy();
    press("Escape", box);
    press("r");
    const note = screen.getByLabelText(/Why reject it/);
    for (const k of ["j", "k", "a", "f"]) press(k, note);
    expect(screen.getByLabelText(/Why reject it/)).toBeTruthy();
    expect(rows().map((r) => r.dataset.id)).toEqual(["c1", "c2", "c3"]);
    expect(rows()[0]!.getAttribute("aria-current")).toBe("true");
    await tick(6000);
    expect(posts()).toEqual([]);
  });

  it("Undo puts the row back where it was and sends nothing", async () => {
    await open();
    press("j");
    press("a");
    expect(rows().map((r) => r.dataset.id)).toEqual(["c1", "c3"]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(rows().map((r) => r.dataset.id)).toEqual(["c1", "c2", "c3"]);
    expect(screen.queryByRole("status")).toBeNull();
    await tick(10_000);
    expect(posts()).toEqual([]);
  });

  it("the next decision sends the previous one at once", async () => {
    await open();
    press("a");
    await tick(1000);
    expect(posts()).toEqual([]);
    press("a");
    await tick(0);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
    expect(rows().map((r) => r.dataset.id)).toEqual(["c3"]);
    await tick(5000);
    expect(posts()).toEqual([
      ["c1", { action: "approve" }],
      ["c2", { action: "approve" }],
    ]);
  });

  it("unmounting sends the pending decision with keepalive", async () => {
    const { unmount } = render(<Review role="curator" />);
    await screen.findByText("candidate c1", { selector: ".text" });
    press("a");
    unmount();
    await tick(0);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
    expect(fetchMock.mock.calls.at(-1)![1]!.keepalive).toBe(true);
  });

  it("a 409 brings the row back in place and says why", async () => {
    reviewStatus = 409;
    await open();
    press("j");
    press("a");
    expect(rows().map((r) => r.dataset.id)).toEqual(["c1", "c3"]);
    await tick(5000);
    expect((await screen.findByRole("alert")).textContent).toMatch(/fact is not a candidate \(409\)/);
    expect(rows().map((r) => r.dataset.id)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("empty and gated", () => {
  it("says when the last distill ran", async () => {
    queue = { candidates: [], last_distill_at: new Date(Date.now() - 3 * 3600_000).toISOString() };
    render(<Review role="curator" />);
    expect((await screen.findByText(/Nothing to review/)).textContent).toBe("Nothing to review. Last distill ran 3 hours ago.");
  });

  it("says when no distill has run", async () => {
    queue = { candidates: [], last_distill_at: null };
    render(<Review role="curator" />);
    expect((await screen.findByText(/Nothing to review/)).textContent).toBe("Nothing to review. No distill has run yet.");
  });

  it("shows the empty state once the last candidate is decided", async () => {
    queue.candidates = [candidate("c1")];
    await open();
    press("a");
    expect(screen.getByText(/Nothing to review/)).toBeTruthy();
  });

  it("members get a note and nothing is fetched", async () => {
    render(<Review role="member" />);
    expect(screen.getByRole("note").textContent).toMatch(/curators only/);
    await tick(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("timeAgo picks a sensible unit", () => {
    const now = Date.parse("2026-11-01T12:00:00Z");
    expect(timeAgo("2026-11-01T11:59:30Z", now)).toBe("30 seconds ago");
    expect(timeAgo("2026-11-01T11:15:00Z", now)).toBe("45 minutes ago");
    expect(timeAgo("2026-11-01T09:00:00Z", now)).toBe("3 hours ago");
    expect(timeAgo("2026-10-31T12:00:00Z", now)).toBe("yesterday");
    expect(timeAgo("2026-08-01T12:00:00Z", now)).toBe("3 months ago");
  });
});
