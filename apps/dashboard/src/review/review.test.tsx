import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Review, timeAgo, type Candidate, type Flagged } from "./Review";

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
    replaces: null,
    ...over,
  };
}

function flaggedFact(id: string, over: Partial<Flagged> = {}): Flagged {
  return {
    id,
    text: `flagged ${id}`,
    kind: "convention",
    scope: "global",
    locus: [],
    origin: "authored",
    status: "active",
    status_note: null,
    author_user_id: "u1",
    recorded_at: "2026-09-01T12:00:00Z",
    correction: { text: `no, ${id} is wrong`, episode_id: "e1", candidate_id: null, at: new Date(Date.now() - 2 * 3600_000).toISOString() },
    replacing: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let queue: { candidates: Candidate[]; flagged: Flagged[]; last_distill_at: string | null };
let reviewStatus: number;
let curateStatus: number;

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/review/queue") return json(queue);
  if (url.pathname === "/v1/teams") return json({ teams: [{ key: "billing", name: "Billing", created_at: "", members: [], repos: [] }] });
  if (url.pathname === "/v1/teams/mine") return json({ teams: [{ key: "billing", name: "Billing", role: "member" }] });
  if (/^\/v1\/facts\/[^/]+\/review$/.test(url.pathname)) {
    return reviewStatus === 200 ? json({ fact: {}, merged_into: null }) : json({ error: "fact is not a candidate" }, reviewStatus);
  }
  if (/^\/v1\/facts\/[^/]+\/curate$/.test(url.pathname)) {
    return curateStatus === 200 ? json({ fact: {} }) : json({ error: "fact is not active" }, curateStatus);
  }
  return json({ error: "not found" }, 404);
});

/** The POSTs to /v1/facts/:id/<via> made so far, as [fact id, body]. */
function posts(via: "review" | "curate" = "review"): [string, unknown][] {
  const re = new RegExp(`/v1/facts/([^/]+)/${via}$`);
  return fetchMock.mock.calls
    .filter(([u, init]) => init?.method === "POST" && re.test(String(u)))
    .map(([u, init]) => [re.exec(String(u))![1]!, JSON.parse(String(init!.body))]);
}

const rows = () => within(screen.getByRole("list", { name: "Candidates" })).getAllByRole("listitem");
const press = (key: string, target: Element | Window = window) => fireEvent.keyDown(target, { key });
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  queue = { candidates: [candidate("c1"), candidate("c2"), candidate("c3")], flagged: [], last_distill_at: null };
  reviewStatus = 200;
  curateStatus = 200;
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

  it("shows the fact a candidate replaces, links to it, and keeps it out of similar", async () => {
    const old = { id: "0d5e6f70-aaaa-bbbb-cccc-000000000001", text: "we deploy on Fridays", kind: "decision", scope: "global", status: "active" };
    queue.candidates[0] = candidate("c1", {
      metadata: { replaces: old.id },
      replaces: old,
      similar: [
        { id: old.id, text: old.text, scope: "global", similarity: 0.95 },
        { id: "s2", text: "another twin", scope: "global", similarity: 0.88 },
      ],
    });
    await open();
    const panel = () => screen.getByRole("complementary", { name: "Evidence" });
    const section = within(panel()).getByRole("region", { name: "Replaces" });
    expect(within(section).getByRole("heading", { name: "Replaces" })).toBeTruthy();
    expect(section.querySelector(".old")!.textContent).toBe("we deploy on Fridays");
    const link = within(section).getByRole("link", { name: "0d5e6f70" });
    expect(link.getAttribute("href")).toBe(`/facts/${old.id}`);
    expect(section.querySelector(".help")!.textContent).toMatch(/Approve or fix retires it\. Reject leaves it as it is\.$/);
    expect([...panel().querySelectorAll(".similar li")].map((li) => li.textContent)).toEqual(["88% another twin"]);

    press("j");
    expect(within(panel()).queryByRole("region", { name: "Replaces" })).toBeNull();
  });

  it("says when the replaced fact is no longer active", async () => {
    const old = { id: "0d5e6f70-aaaa-bbbb-cccc-000000000001", text: "we deploy on Fridays", kind: "decision", scope: "global", status: "superseded" };
    queue.candidates[0] = candidate("c1", { replaces: old });
    await open();
    const section = screen.getByRole("region", { name: "Replaces" });
    expect(section.querySelector(".help")!.textContent).toMatch(/Already superseded\. Approving won't change it\.$/);
  });

  it("a on a replacing candidate still posts a plain approve", async () => {
    const old = { id: "0d5e6f70-aaaa-bbbb-cccc-000000000001", text: "we deploy on Fridays", kind: "decision", scope: "global", status: "active" };
    queue.candidates[0] = candidate("c1", { replaces: old });
    await open();
    press("a");
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
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
    const queueCall = fetchMock.mock.calls.map(([u]) => new URL(String(u), "http://hive")).find((u) => u.pathname === "/v1/review/queue");
    expect(queueCall!.search).toBe("?limit=100");
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

describe("without a keyboard", () => {
  const decide = () => within(screen.getByRole("group", { name: "Decide" }));
  const tap = (name: string) => fireEvent.click(decide().getByRole("button", { name }));

  it("the stepper moves between candidates and stops at the ends", async () => {
    await open();
    const prev = screen.getByRole("button", { name: "Previous candidate" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next candidate" }) as HTMLButtonElement;
    expect(screen.getByText("Candidate 1 of 3")).toBeTruthy();
    expect(prev.disabled).toBe(true);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText("Candidate 3 of 3")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Evidence" }).querySelector(".fact-text")!.textContent).toBe("candidate c3");
    expect(next.disabled).toBe(true);
    fireEvent.click(prev);
    expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
  });

  it("Approve approves the current candidate after the undo window", async () => {
    await open();
    tap("Approve");
    expect(screen.getByText("Candidate 1 of 2")).toBeTruthy();
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
  });

  it("Fix… opens the text; Save fix is off under 3 chars and sends the fix", async () => {
    await open();
    tap("Fix…");
    const box = screen.getByLabelText("Fixed text");
    fireEvent.change(box, { target: { value: "ab" } });
    expect((decide().getByRole("button", { name: "Save fix" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "candidate c1, tightened" } });
    tap("Save fix");
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "fix", new_text: "candidate c1, tightened" }]]);
  });

  it("Reject… asks for a note, Cancel backs out, and Reject sends it", async () => {
    await open();
    tap("Reject…");
    tap("Cancel");
    expect(screen.queryByLabelText(/Why reject it/)).toBeNull();
    tap("Reject…");
    fireEvent.change(screen.getByLabelText(/Why reject it/), { target: { value: "not true any more" } });
    tap("Reject");
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "reject", note: "not true any more" }]]);
  });

  it("a long bot turn is cut short until Show all of it, and is cut again on the next candidate", async () => {
    const said = (id: string, assistant: string) => ({
      id,
      episode_id: "e1",
      repo_key: null,
      path: null,
      line_start: null,
      line_end: null,
      quote: "u",
      verify_status: "unverified",
      episode_snippet: null,
      exchange: { assistant, user: "u" },
    });
    queue.candidates = [
      candidate("c1", { anchors: [said("a1", "a long reply")] }),
      candidate("c2", { anchors: [said("a2", "another reply")] }),
    ];
    await open();
    const bot = () => screen.getByText("a long reply").closest(".exchange-bot")!;
    expect(bot().classList.contains("clamped")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show all of it" }));
    expect(bot().classList.contains("clamped")).toBe(false);
    press("j");
    expect(screen.getByText("another reply").closest(".exchange-bot")!.classList.contains("clamped")).toBe(true);
  });
});

describe("levels", () => {
  it("badges each candidate, its evidence and a flagged fact, working the level out from scope", async () => {
    queue.candidates = [candidate("c1", { scope: "team:billing" }), candidate("c2", { scope: "repo:gh/o/a" })];
    queue.flagged = [flaggedFact("f1", { scope: "personal:u1" })];
    await open();
    await within(rows()[0]!).findByText("your team");
    expect(rows()[0]!.querySelector(".level")!.textContent).toBe("Team: Billingyour team");
    expect(rows()[1]!.querySelector(".level")!.textContent).toBe("Repository");
    const panel = screen.getByRole("complementary", { name: "Evidence" });
    expect(panel.querySelector(".level")!.textContent).toBe("Team: Billingyour team");
    const flagged = screen.getByRole("region", { name: "Corrected after citation" });
    expect(flagged.querySelector(".level")!.textContent).toBe("Personal");
  });

  it("the Level filter narrows candidates and flagged facts here", async () => {
    queue.candidates = [candidate("c1", { scope: "team:billing" }), candidate("c2"), candidate("c3", { scope: "team:billing" })];
    queue.flagged = [flaggedFact("f1")];
    await open();
    await screen.findByRole("option", { name: "Team: Billing" });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "team:billing" } });
    expect(rows().map((r) => r.dataset.id)).toEqual(["c1", "c3"]);
    expect(screen.queryByRole("region", { name: "Corrected after citation" })).toBeNull();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/v1/review/queue"))).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "personal" } });
    expect(screen.getByText("Nothing to review at this level.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "" } });
    expect(rows()).toHaveLength(3);
  });
});

describe("corrected after citation", () => {
  const C2 = "c2aaaaaa-0000-0000-0000-000000000002";
  const section = () => screen.getByRole("region", { name: "Corrected after citation" });
  const card = (id: string) => section().querySelector<HTMLElement>(`li[data-id="${id}"]`);

  beforeEach(() => {
    queue.candidates[1] = candidate(C2);
    queue.flagged = [
      flaggedFact("f1", { correction: { ...flaggedFact("f1").correction, candidate_id: C2 }, replacing: { id: C2, text: `candidate ${C2}` } }),
      flaggedFact("f2"),
    ];
  });

  it("shows the fact, when and how it was corrected, and links to the replacing candidate", async () => {
    await open();
    const f1 = card("f1")!;
    expect(within(section()).getByRole("heading", { name: "Corrected after citation" })).toBeTruthy();
    expect(f1.querySelector(".fact-text")!.textContent).toBe("flagged f1");
    expect(f1.querySelector(".meta")!.textContent).toBe("convention in Organisation. Corrected 2 hours ago.");
    expect(f1.querySelector("blockquote")!.textContent).toBe("no, f1 is wrong");
    expect(f1.querySelector(".help")!.textContent).toBe("Replaced by candidate c2aaaaaa");
    expect(within(f1).getByRole("link", { name: "c2aaaaaa" })).toBeTruthy();
    expect(card("f2")!.textContent).not.toMatch(/Replaced by/);
    expect(screen.getByText(/to review\./).textContent).toMatch(/^5 to review\./);
  });

  it("the link selects the replacing candidate and focuses its row", async () => {
    await open();
    fireEvent.click(within(card("f1")!).getByRole("link", { name: "c2aaaaaa" }));
    expect(rows()[1]!.getAttribute("aria-current")).toBe("true");
    expect(document.activeElement).toBe(rows()[1]);
    expect(screen.getByRole("complementary", { name: "Evidence" }).querySelector(".fact-text")!.textContent).toBe(`candidate ${C2}`);
  });

  it("names the replacing candidate without a link when it isn't loaded", async () => {
    queue.candidates.splice(1, 1);
    await open();
    expect(card("f1")!.querySelector(".help")!.textContent).toBe("Replaced by candidate c2aaaaaa");
    expect(within(card("f1")!).queryByRole("link")).toBeNull();
  });

  it("Keep curates after the undo window", async () => {
    await open();
    fireEvent.click(within(card("f2")!).getByRole("button", { name: "Keep" }));
    expect(card("f2")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/^Kept·Undo$/);
    await tick(4900);
    expect(posts("curate")).toEqual([]);
    await tick(200);
    expect(posts("curate")).toEqual([["f2", { action: "keep" }]]);
    expect(posts("review")).toEqual([]);
  });

  it("Fix opens the text; Enter curates a fix with new_text, and under 3 chars does nothing", async () => {
    await open();
    fireEvent.click(within(card("f1")!).getByRole("button", { name: "Fix" }));
    const box = within(card("f1")!).getByLabelText("Fixed text") as HTMLTextAreaElement;
    expect(box.value).toBe("flagged f1");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: " x " } });
    press("Enter", box);
    expect(card("f1")).not.toBeNull();
    fireEvent.change(box, { target: { value: "  flagged f1, fixed  " } });
    press("Enter", box);
    expect(card("f1")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/^Fixed/);
    await tick(5000);
    expect(posts("curate")).toEqual([["f1", { action: "fix", new_text: "flagged f1, fixed" }]]);
  });

  it("Esc closes the fix box without deciding anything", async () => {
    await open();
    fireEvent.click(within(card("f1")!).getByRole("button", { name: "Fix" }));
    press("Escape", within(card("f1")!).getByLabelText("Fixed text"));
    expect(within(card("f1")!).queryByLabelText("Fixed text")).toBeNull();
    await tick(6000);
    expect(posts("curate")).toEqual([]);
  });

  it("Retire asks for an optional note and curates a retire", async () => {
    await open();
    fireEvent.click(within(card("f1")!).getByRole("button", { name: "Retire" }));
    const note = within(card("f1")!).getByLabelText(/Why retire it/);
    fireEvent.change(note, { target: { value: "wrong since v2" } });
    press("Enter", note);
    expect(screen.getByRole("status").textContent).toMatch(/^Retired/);
    fireEvent.click(within(card("f2")!).getByRole("button", { name: "Retire" }));
    fireEvent.click(within(card("f2")!).getByRole("button", { name: "Retire fact" }));
    await tick(5000);
    expect(posts("curate")).toEqual([
      ["f1", { action: "retire", note: "wrong since v2" }],
      ["f2", { action: "retire" }],
    ]);
  });

  it("Undo puts the card back and sends nothing", async () => {
    await open();
    fireEvent.click(within(card("f1")!).getByRole("button", { name: "Keep" }));
    expect(card("f1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(card("f1")).not.toBeNull();
    await tick(10_000);
    expect(posts("curate")).toEqual([]);
  });

  it("a 409 brings the card back and says why", async () => {
    curateStatus = 409;
    await open();
    fireEvent.click(within(card("f1")!).getByRole("button", { name: "Keep" }));
    expect(card("f1")).toBeNull();
    await tick(5000);
    expect((await screen.findByRole("alert")).textContent).toMatch(/fact is not active \(409\)/);
    expect(card("f1")).not.toBeNull();
  });

  it("a, f and r still act only on candidates", async () => {
    await open();
    press("f");
    expect(screen.getByRole("complementary", { name: "Evidence" }).querySelector("textarea")).not.toBeNull();
    expect(section().querySelector("textarea")).toBeNull();
    press("Escape", screen.getByLabelText("Fixed text", { selector: "#r-fix" }));
    press("a");
    await tick(5000);
    expect(posts("review")).toEqual([["c1", { action: "approve" }]]);
    expect(posts("curate")).toEqual([]);
    expect(card("f1")).not.toBeNull();
  });

  it("shows no section when nothing is flagged", async () => {
    queue.flagged = [];
    await open();
    expect(screen.queryByRole("region", { name: "Corrected after citation" })).toBeNull();
    expect(screen.getByText(/to review\./).textContent).toMatch(/^3 to review\./);
  });

  it("is not empty while a flagged fact is left, and is once both lists are", async () => {
    queue.candidates = [];
    queue.flagged = [flaggedFact("f1")];
    render(<Review role="curator" />);
    await screen.findByText("flagged f1");
    expect(screen.queryByText(/Nothing to review/)).toBeNull();
    expect(screen.queryByRole("list", { name: "Candidates" })).toBeNull();
    expect(screen.getByText(/to review\./).textContent).toBe("1 to review.");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByText(/Nothing to review/)).toBeTruthy();
  });
});

describe("empty and gated", () => {
  it("says when the last distill ran", async () => {
    queue = { candidates: [], flagged: [], last_distill_at: new Date(Date.now() - 3 * 3600_000).toISOString() };
    render(<Review role="curator" />);
    expect((await screen.findByText(/Nothing to review/)).textContent).toBe("Nothing to review. Last distill ran 3 hours ago.");
  });

  it("says when no distill has run", async () => {
    queue = { candidates: [], flagged: [], last_distill_at: null };
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
