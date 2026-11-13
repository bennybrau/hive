import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KINDS, ORIGINS } from "../facts/query";
import { RAW_VALUES, VERIFY, when } from "../words";
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

type Anchor = Candidate["anchors"][number];

function anchorOf(over: Partial<Anchor> = {}): Anchor {
  return {
    id: "a1",
    episode_id: null,
    repo_key: null,
    path: null,
    line_start: null,
    line_end: null,
    quote: null,
    verify_status: "unverified",
    episode_snippet: null,
    exchange: null,
    source: null,
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
let mergedInto: { id: string } | null;
let curateStatus: number;
let repoKeys: string[];

const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/review/queue") return json(queue);
  if (url.pathname === "/v1/teams") {
    return json({
      teams: [
        { key: "billing", name: "Billing", created_at: "", members: [], repos: [] },
        { key: "platform", name: "Platform", created_at: "", members: [], repos: [] },
      ],
    });
  }
  if (url.pathname === "/v1/repo-keys") return json({ repo_keys: repoKeys });
  if (url.pathname === "/v1/teams/mine") return json({ teams: [{ key: "billing", name: "Billing", role: "member" }] });
  if (/^\/v1\/facts\/[^/]+\/review$/.test(url.pathname)) {
    return reviewStatus === 200 ? json({ fact: {}, merged_into: mergedInto }) : json({ error: "fact is not a candidate" }, reviewStatus);
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

const card = () => screen.getByRole("article", { name: "Fact" });
/** The card's fact id and position, e.g. "c2 2/3". */
const at = () => `${card().dataset.id} ${/Fact (\d+) of (\d+)/.exec(card().textContent!)!.slice(1).join("/")}`;
const proposed = () => card().querySelector(".proposed")?.textContent;
const why = () => within(card()).queryByRole("region", { name: "Why Hive thinks so" });
const press = (key: string, target: Element | Window = window) => fireEvent.keyDown(target, { key });
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const decide = () => within(screen.getByRole("group", { name: "Decide" }));
const tap = (name: string) => fireEvent.click(decide().getByRole("button", { name }));
const change = () => fireEvent.click(within(card()).getByRole("button", { name: "Change…" }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  queue = { candidates: [candidate("c1"), candidate("c2"), candidate("c3")], flagged: [], last_distill_at: null };
  reviewStatus = 200;
  mergedInto = null;
  curateStatus = 200;
  repoKeys = ["gh/acme/other", "gh/acme/proj", "local"];
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
  await screen.findByText("candidate c1", { selector: ".proposed" });
}

describe("the card", () => {
  it("has no list, a header with the lede and Level, and its slots in order", async () => {
    queue.candidates[0] = candidate("c1", {
      anchors: [anchorOf({ episode_id: "e1", quote: "q", exchange: { assistant: "a", user: "u" } })],
      replaces: { id: "0d5e6f70-0000", text: "old", kind: "decision", scope: "global", status: "active" },
    });
    await open();
    expect(screen.queryByRole("list", { name: "Candidates" })).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Review");
    expect(document.querySelector(".lede")!.textContent).toBe(
      "Hive proposes facts from what people say. Nothing reaches an agent until a curator approves it.",
    );
    expect(screen.getByLabelText("Level")).toBeTruthy();
    const order = [".pos", ".badges", ".proposed", ".gets", ".why", ".replaces", "details", "footer"].map((sel) => card().querySelector(sel)!);
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("shows where it is in the queue; ‹ and › move and stop at the ends", async () => {
    await open();
    const prev = within(card()).getByRole("button", { name: "Previous fact" }) as HTMLButtonElement;
    const next = within(card()).getByRole("button", { name: "Next fact" }) as HTMLButtonElement;
    expect(at()).toBe("c1 1/3");
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(within(card()).getByRole("button", { name: "Next fact" }));
    fireEvent.click(within(card()).getByRole("button", { name: "Next fact" }));
    expect(at()).toBe("c3 3/3");
    expect(proposed()).toBe("candidate c3");
    expect((within(card()).getByRole("button", { name: "Next fact" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card()).getByRole("button", { name: "Previous fact" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(card()).getByRole("button", { name: "Previous fact" }));
    expect(at()).toBe("c2 2/3");
  });

  it("shows the fact's text with its kind and origin in words, and marks one the user asked to remember", async () => {
    queue.candidates[0] = candidate("c1", { kind: "gotcha", origin: "ingested", metadata: { asked: true } });
    await open();
    expect(proposed()).toBe("candidate c1");
    const badges = () => [...card().querySelectorAll(".badges .ui-badge")].map((b) => b.textContent);
    expect(badges()).toEqual(["Pitfall", "Read from the repo", "asked to remember"]);
    press("j");
    expect(badges()).toEqual(["Decision", "Learned from a conversation"]);
  });

  it("says who gets it; Change… opens Who should get this? in place", async () => {
    queue.candidates[0] = candidate("c1", { scope: "team:billing" });
    await open();
    const gets = card().querySelector(".gets")!;
    await within(gets as HTMLElement).findByText("your team");
    expect(gets.querySelector(".level")!.textContent).toBe("Team: Billingyour team");
    expect(gets.querySelector(".t")!.textContent).toBe("Who gets it: This team first; others can still find it.");
    const button = within(card()).getByRole("button", { name: "Change…" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Who should get this?" })).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(gets.contains(screen.getByRole("group", { name: "Who should get this?" }))).toBe(true);
    fireEvent.click(await screen.findByRole("radio", { name: "Everyone" }));
    expect(gets.querySelector(".level")!.textContent).toBe("Everyone");
    expect(gets.querySelector(".t")!.textContent).toBe("Who gets it: Agents in every repository, for every team.");
  });
});

describe("why Hive thinks so", () => {
  const twoHoursAgo = () => new Date(Date.now() - 2 * 3600_000).toISOString();
  const said = (source: Anchor["source"]) =>
    candidate("c1", {
      anchors: [anchorOf({ episode_id: "e1", quote: "we use Postgres", episode_snippet: "...we use Postgres...", exchange: { assistant: "I'll add Redis.", user: "no, we use Postgres" }, source })],
    });
  const by = () => why()!.querySelector(".by");

  it("quotes the user turn with who said it, where and when", async () => {
    const at = twoHoursAgo();
    queue.candidates = [said({ kind: "asf_dialog", author: "Jon", where: "factory_plan_note", at })];
    await open();
    const quote = why()!.querySelector("blockquote")!;
    expect(quote.firstChild!.textContent).toBe("no, we use Postgres");
    expect(by()!.textContent).toBe("Jon, in a factory plan approval, 2 hours ago");
    expect(by()!.querySelector("time")!.getAttribute("title")).toBe(when(at).title);
    expect(within(card()).queryByText("...we use Postgres...")).toBeNull();
  });

  it("leaves out a missing author, an other place, and the whole line without a source", async () => {
    queue.candidates = [
      said({ kind: "turn", author: null, where: "conversation", at: twoHoursAgo() }),
      said({ kind: "note", author: "Jon", where: "other", at: twoHoursAgo() }),
      said({ kind: "note", author: null, where: "other", at: twoHoursAgo() }),
      said(null),
    ];
    queue.candidates.forEach((c, i) => (c.id = `c${i + 1}`));
    await open();
    expect(by()!.textContent).toBe("In a conversation with Hermes, 2 hours ago");
    press("j");
    expect(by()!.textContent).toBe("Jon, 2 hours ago");
    press("j");
    expect(by()!.textContent).toBe("2 hours ago");
    press("j");
    expect(why()!.querySelector("blockquote")!.textContent).toBe("no, we use Postgres");
    expect(by()).toBeNull();
  });

  it("falls back to the conversation snippet, then the quote, then the file, and has no section without anchors", async () => {
    queue.candidates = [
      candidate("c1", { anchors: [anchorOf({ episode_id: "e1", quote: "kafka", episode_snippet: "assistant: use kafka" })] }),
      candidate("c2", { anchors: [anchorOf({ repo_key: "gh/o/a", path: "src/a.ts", line_start: 10, line_end: 14, quote: "const a = 1;" })] }),
      candidate("c3", { anchors: [anchorOf({ repo_key: "gh/o/a", path: "src/b.ts", line_start: 3 })] }),
      candidate("c4"),
    ];
    await open();
    expect(why()!.querySelector("blockquote")!.textContent).toBe("assistant: use kafka");
    press("j");
    expect(why()!.querySelector("blockquote")!.firstChild!.textContent).toBe("const a = 1;");
    expect(why()!.querySelector(".by")!.textContent).toBe("gh/o/a src/a.ts:L10–L14");
    press("j");
    expect(why()!.querySelector("blockquote")).toBeNull();
    expect(why()!.textContent).toBe("Why Hive thinks sogh/o/a src/b.ts:L3");
    press("j");
    expect(why()).toBeNull();
  });
});

describe("folded", () => {
  const OLD = { id: "0d5e6f70-aaaa-bbbb-cccc-000000000001", text: "we deploy on Fridays", kind: "decision", scope: "global", status: "active" };
  const fold = (summary: string) =>
    [...card().querySelectorAll("details")].find((d) => d.querySelector("summary")!.textContent === summary) as HTMLDetailsElement | undefined;

  it("what the agent said, similar facts and details are closed; Replaces is shown", async () => {
    queue.candidates[0] = candidate("c1", {
      anchors: [anchorOf({ episode_id: "e1", quote: "u", exchange: { assistant: "I'll add Redis.", user: "u" } })],
      replaces: OLD,
      similar: [
        { id: OLD.id, text: OLD.text, scope: "global", similarity: 0.95 },
        { id: "s2", text: "another twin", scope: "global", similarity: 0.88 },
      ],
    });
    await open();
    expect([...card().querySelectorAll("details")].map((d) => [d.querySelector("summary")!.textContent, d.open])).toEqual([
      ["The agent said", false],
      ["Similar live facts (1)", false],
      ["Details", false],
    ]);
    expect(fold("The agent said")!.querySelector(".said")!.textContent).toBe("I'll add Redis.");
    expect([...fold("Similar live facts (1)")!.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["88% another twin"]);

    const section = within(card()).getByRole("region", { name: "Replaces" });
    expect(section.closest("details")).toBeNull();
    expect(section.querySelector(".old")!.textContent).toBe("we deploy on Fridays");
    expect(within(section).getByRole("link", { name: "0d5e6f70" }).getAttribute("href")).toBe(`/facts/${OLD.id}`);
    expect(section.querySelector(".help")!.textContent).toMatch(/Approve or edit retires it\. Reject leaves it as it is\.$/);

    press("j");
    expect(within(card()).queryByRole("region", { name: "Replaces" })).toBeNull();
    expect([...card().querySelectorAll("details summary")].map((s) => s.textContent)).toEqual(["Details"]);
  });

  it("says, in words, when the replaced fact is no longer live", async () => {
    queue.candidates[0] = candidate("c1", { replaces: { ...OLD, status: "superseded" } });
    await open();
    expect(screen.getByRole("region", { name: "Replaces" }).querySelector(".help")!.textContent).toMatch(/Already replaced\. Approving won't change it\.$/);
  });

  it("Details has the id, when it was recorded, the conversation and where it comes from", async () => {
    queue.candidates[0] = candidate("c1", {
      anchors: [
        anchorOf({ repo_key: "gh/o/a", path: "src/a.ts", line_start: 10, line_end: 14, quote: "const a = 1;", verify_status: "drifted" }),
        anchorOf({ id: "a2", episode_id: "ep-42", quote: "we agreed", episode_snippet: "so we agreed" }),
      ],
    });
    await open();
    const dl = fold("Details")!.querySelector("dl")!;
    const rows = [...dl.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!] as const);
    expect(rows.map(([k]) => k)).toEqual(["Id", "Recorded", "Conversation", "Where this comes from"]);
    expect(rows[0]![1].textContent).toBe("c1");
    const time = rows[1]![1].querySelector("time")!;
    expect(time.textContent).toBe(when("2026-10-01T12:00:00Z").text);
    expect(time.getAttribute("title")).toBe(when("2026-10-01T12:00:00Z").title);
    expect(rows[2]![1].textContent).toBe("ep-42");
    expect([...rows[3]![1].querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "gh/o/a src/a.ts:L10–L14 Source changedconst a = 1;",
      "From a conversation Not checked yetwe agreed",
    ]);
  });
});

describe("the footer", () => {
  it("has one primary button, Approve for the level, then Edit… and Reject", async () => {
    await open();
    const buttons = () => decide().getAllByRole("button").map((b) => [b.textContent, b.classList.contains("primary")]);
    expect(buttons()).toEqual([
      ["Approve for Everyone", true],
      ["Edit…", false],
      ["Reject", false],
      ["? keys", false],
    ]);
    expect(document.querySelectorAll("button.primary")).toHaveLength(1);
    tap("Edit…");
    expect(document.querySelectorAll("button.primary")).toHaveLength(1);
    expect(decide().getByRole("button", { name: "Save and approve" }).classList.contains("primary")).toBe(true);
  });

  it("? keys shows and hides the shortcuts", async () => {
    await open();
    const keys = decide().getByRole("button", { name: "? keys" });
    expect(keys.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("table", { name: "Keyboard shortcuts" })).toBeNull();
    fireEvent.click(keys);
    expect(keys.getAttribute("aria-expanded")).toBe("true");
    const table = screen.getByRole("table", { name: "Keyboard shortcuts" });
    expect(keys.getAttribute("aria-controls")).toBe(table.id);
    expect([...table.querySelectorAll("tr")].map((r) => r.textContent)).toContain("aApprove");
    fireEvent.click(keys);
    expect(screen.queryByRole("table", { name: "Keyboard shortcuts" })).toBeNull();
  });
});

describe("keyboard", () => {
  it("j and k move the card and stop at the ends", async () => {
    await open();
    press("j");
    press("j");
    expect(at()).toBe("c3 3/3");
    press("j");
    expect(at()).toBe("c3 3/3");
    press("ArrowUp");
    expect(at()).toBe("c2 2/3");
    press("ArrowDown");
    expect(at()).toBe("c3 3/3");
  });

  it("asks for the first 100 of the queue", async () => {
    await open();
    const queueCall = fetchMock.mock.calls.map(([u]) => new URL(String(u), "http://hive")).find((u) => u.pathname === "/v1/review/queue");
    expect(queueCall!.search).toBe("?limit=100");
  });

  it("a approves: the card goes, the toast offers Undo, and the POST goes out after 5 s", async () => {
    await open();
    press("a");
    expect(at()).toBe("c2 1/2");
    expect(screen.getByRole("status").textContent).toMatch(/^Approved·Undo$/);
    await tick(4900);
    expect(posts()).toEqual([]);
    await tick(200);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
    expect(screen.queryByRole("status")).toBeNull();
    await tick(10_000);
    expect(posts()).toHaveLength(1);
  });

  it("a on a replacing candidate still posts a plain approve", async () => {
    queue.candidates[0] = candidate("c1", { replaces: { id: "0d5e6f70", text: "old", kind: "decision", scope: "global", status: "active" } });
    await open();
    press("a");
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
  });

  it("f opens the text for editing in place of it; Enter sends a fix with new_text", async () => {
    await open();
    press("j");
    press("f");
    const box = screen.getByLabelText("Edit the fact") as HTMLTextAreaElement;
    expect(box.value).toBe("candidate c2");
    expect(document.activeElement).toBe(box);
    expect(proposed()).toBeUndefined();
    fireEvent.change(box, { target: { value: "  candidate c2, tightened  " } });
    press("Enter", box);
    expect(screen.getByRole("status").textContent).toMatch(/^Fixed/);
    await tick(5000);
    expect(posts()).toEqual([["c2", { action: "fix", new_text: "candidate c2, tightened" }]]);
  });

  it("Esc closes the edit box without deciding anything", async () => {
    await open();
    press("f");
    press("Escape", screen.getByLabelText("Edit the fact"));
    expect(screen.queryByLabelText("Edit the fact")).toBeNull();
    expect(at()).toBe("c1 1/3");
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

  it("keys typed in the edit box and the note do nothing", async () => {
    await open();
    press("f");
    const box = screen.getByLabelText("Edit the fact");
    for (const k of ["j", "k", "a", "r", "f"]) press(k, box);
    expect(screen.getByLabelText("Edit the fact")).toBeTruthy();
    press("Escape", box);
    press("r");
    const note = screen.getByLabelText(/Why reject it/);
    for (const k of ["j", "k", "a", "f"]) press(k, note);
    expect(screen.getByLabelText(/Why reject it/)).toBeTruthy();
    expect(at()).toBe("c1 1/3");
    await tick(6000);
    expect(posts()).toEqual([]);
  });

  it("Undo puts the card back where it was and sends nothing", async () => {
    await open();
    press("j");
    press("a");
    expect(at()).toBe("c3 2/2");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(at()).toBe("c2 2/3");
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
    expect(at()).toBe("c3 1/1");
    await tick(5000);
    expect(posts()).toEqual([
      ["c1", { action: "approve" }],
      ["c2", { action: "approve" }],
    ]);
  });

  it("unmounting sends the pending decision with keepalive", async () => {
    const { unmount } = render(<Review role="curator" />);
    await screen.findByText("candidate c1", { selector: ".proposed" });
    press("a");
    unmount();
    await tick(0);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
    expect(fetchMock.mock.calls.at(-1)![1]!.keepalive).toBe(true);
  });

  it("a 409 brings the card back in place and says why", async () => {
    reviewStatus = 409;
    await open();
    press("j");
    press("a");
    expect(at()).toBe("c3 2/2");
    await tick(5000);
    expect((await screen.findByRole("alert")).textContent).toMatch(/fact is not a candidate \(409\)/);
    expect(at()).toBe("c2 2/3");
    press("j");
    expect(at()).toBe("c3 3/3");
  });
});

describe("without a keyboard", () => {
  it("Approve approves the current fact after the undo window", async () => {
    await open();
    tap("Approve for Everyone");
    expect(at()).toBe("c2 1/2");
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
  });

  it("Edit… opens the text; Save and approve is off under 3 chars and sends the fix", async () => {
    await open();
    tap("Edit…");
    const box = screen.getByLabelText("Edit the fact");
    fireEvent.change(box, { target: { value: "ab" } });
    expect((decide().getByRole("button", { name: "Save and approve" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "candidate c1, tightened" } });
    tap("Save and approve");
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "fix", new_text: "candidate c1, tightened" }]]);
  });

  it("Reject asks for a note, Cancel backs out, and Reject sends it", async () => {
    await open();
    tap("Reject");
    tap("Cancel");
    expect(screen.queryByLabelText(/Why reject it/)).toBeNull();
    tap("Reject");
    fireEvent.change(screen.getByLabelText(/Why reject it/), { target: { value: "not true any more" } });
    tap("Reject");
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "reject", note: "not true any more" }]]);
  });
});

describe("levels", () => {
  it("badges the card and a flagged fact, working the level out from scope", async () => {
    queue.candidates = [candidate("c1", { scope: "team:billing" }), candidate("c2", { scope: "repo:gh/o/a" })];
    queue.flagged = [flaggedFact("f1", { scope: "personal:u1" })];
    await open();
    await within(card()).findByText("your team");
    expect(card().querySelector(".level")!.textContent).toBe("Team: Billingyour team");
    press("j");
    expect(card().querySelector(".level")!.textContent).toBe("Repo: a");
    const flagged = screen.getByRole("region", { name: "Corrected after citation" });
    expect(flagged.querySelector(".level")!.textContent).toBe("Just me");
  });

  it("the Level filter narrows candidates and flagged facts here", async () => {
    queue.candidates = [candidate("c1", { scope: "team:billing" }), candidate("c2"), candidate("c3", { scope: "team:billing" })];
    queue.flagged = [flaggedFact("f1")];
    await open();
    await screen.findByRole("option", { name: "Team: Billing" });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "team:billing" } });
    expect(at()).toBe("c1 1/2");
    press("j");
    expect(at()).toBe("c3 2/2");
    expect(screen.queryByRole("region", { name: "Corrected after citation" })).toBeNull();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/v1/review/queue"))).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "personal" } });
    expect(screen.getByText("Nothing to review at this level.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "" } });
    expect(at()).toMatch(/ \d\/3$/);
  });
});

describe("who should get this", () => {
  const anchor = (repo_key: string) => anchorOf({ repo_key, path: "README.md", line_start: 1, line_end: 1, verify_status: "verified" });
  const who = () => within(screen.getByRole("group", { name: "Who should get this?" }));
  const radios = () =>
    who()
      .getAllByRole("radio")
      .map((r) => [document.querySelector(`label[for="${r.id}"]`)!.textContent, (r as HTMLInputElement).checked]);
  const hint = (name: string) => document.getElementById(who().getByRole("radio", { name }).getAttribute("aria-describedby")!)!.textContent;
  const pick = (name: string) => fireEvent.click(who().getByRole("radio", { name }));
  const other = () => who().getByLabelText("Another repo") as HTMLSelectElement;
  const approveButton = () => decide().getByRole("button", { name: /^Approve for / });
  /** Opens Change… on the current card and waits for its teams and repos. */
  const loaded = async () => {
    if (!screen.queryByRole("group", { name: "Who should get this?" })) change();
    await who().findByRole("radio", { name: "Team: Platform" });
    await who().findByRole("option", { name: "local" });
  };

  it("lists the current level first, then the anchor repo, another repo, the teams and Everyone; never Just me", async () => {
    queue.candidates = [candidate("c1", { anchors: [anchor("gh/acme/proj")] }), candidate("c2", { scope: "team:billing" })];
    await open();
    await loaded();
    expect(radios()).toEqual([
      ["Everyone (current)", true],
      ["Repo: proj", false],
      ["Another repo…", false],
      ["Team: Billing", false],
      ["Team: Platform", false],
    ]);
    expect([...other().options].map((o) => [o.value, o.title])).toEqual([
      ["gh/acme/other", "repo:gh/acme/other"],
      ["local", "repo:local"],
    ]);
    expect(hint("Everyone (current)")).toBe("Agents in every repository, for every team.");
    expect(hint("Repo: proj")).toBe("Agents working in this repository.");
    expect(hint("Team: Billing")).toBe("This team first; others can still find it.");
    expect(approveButton().textContent).toBe("Approve for Everyone");
    press("j");
    expect(screen.queryByRole("group", { name: "Who should get this?" })).toBeNull();
    await loaded();
    expect(radios()).toEqual([
      ["Team: Billing (current)", true],
      ["Another repo…", false],
      ["Team: Platform", false],
      ["Everyone", false],
    ]);
    expect(approveButton().textContent).toBe("Approve for Team: Billing");
  });

  it("leaves the candidate's own repo out of Another repo…, and turns it off when no repo is left", async () => {
    queue.candidates = [candidate("c1", { scope: "repo:local", anchors: [anchor("gh/acme/proj")] })];
    repoKeys = ["gh/acme/proj", "local"];
    await open();
    change();
    await who().findByRole("radio", { name: "Team: Platform" });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === "/v1/repo-keys")).toBe(true));
    expect(radios().map(([l]) => l)).toEqual(["Repo: local (current)", "Repo: proj", "Another repo…", "Team: Billing", "Team: Platform", "Everyone"]);
    expect(other().options).toHaveLength(0);
    expect(other().disabled).toBe(true);
    expect((who().getByRole("radio", { name: "Another repo…" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("names the choice on the Approve button", async () => {
    queue.candidates = [candidate("c1", { anchors: [anchor("gh/acme/proj")] })];
    await open();
    await loaded();
    pick("Repo: proj");
    expect(approveButton().textContent).toBe("Approve for Repo: proj");
    pick("Team: Billing");
    expect(approveButton().textContent).toBe("Approve for Team: Billing");
    fireEvent.change(other(), { target: { value: "local" } });
    expect((who().getByRole("radio", { name: "Another repo…" }) as HTMLInputElement).checked).toBe(true);
    expect(approveButton().textContent).toBe("Approve for Repo: local");
    pick("Everyone (current)");
    expect(approveButton().textContent).toBe("Approve for Everyone");
  });

  it("the current level sends no scope", async () => {
    await open();
    await loaded();
    pick("Team: Billing");
    pick("Everyone (current)");
    fireEvent.click(approveButton());
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "approve" }]]);
  });

  it("Approve sends the chosen scope, and so does a", async () => {
    queue.candidates = [candidate("c1", { anchors: [anchor("gh/acme/proj")] }), candidate("c2"), candidate("c3")];
    await open();
    await loaded();
    pick("Repo: proj");
    fireEvent.click(approveButton());
    await loaded();
    pick("Team: Billing");
    press("a");
    await loaded();
    fireEvent.change(other(), { target: { value: "gh/acme/other" } });
    press("a");
    await tick(5000);
    expect(posts()).toEqual([
      ["c1", { action: "approve", scope: "repo:gh/acme/proj" }],
      ["c2", { action: "approve", scope: "team:billing" }],
      ["c3", { action: "approve", scope: "repo:gh/acme/other" }],
    ]);
  });

  it("goes back to the current level on the next candidate, is hidden while editing, and edit never sends it", async () => {
    await open();
    await loaded();
    pick("Team: Billing");
    press("j");
    await loaded();
    expect(radios()[0]).toEqual(["Everyone (current)", true]);
    press("k");
    await loaded();
    expect(radios()[0]).toEqual(["Everyone (current)", true]);
    pick("Team: Billing");
    press("f");
    expect(screen.queryByRole("group", { name: "Who should get this?" })).toBeNull();
    expect(card().querySelector(".gets")).toBeNull();
    const box = screen.getByLabelText("Edit the fact");
    fireEvent.change(box, { target: { value: "candidate c1, tightened" } });
    press("Enter", box);
    await tick(5000);
    expect(posts()).toEqual([["c1", { action: "fix", new_text: "candidate c1, tightened" }]]);
  });

  it("says what an approve was merged into, links to it, and clears on the next decision", async () => {
    const into = "7a8b9c0d-aaaa-bbbb-cccc-000000000001";
    mergedInto = { id: into };
    await open();
    await loaded();
    pick("Team: Billing");
    press("a");
    await tick(5000);
    const link = await screen.findByRole("link", { name: "7a8b9c0d" });
    expect(link.closest("p")!.textContent).toBe("Merged into 7a8b9c0d");
    expect(link.closest("p")!.getAttribute("role")).toBeNull();
    expect(link.getAttribute("href")).toBe(`/facts/${into}`);
    press("a");
    expect(screen.queryByText(/Merged into/)).toBeNull();
  });

  it("says what a fix was merged into", async () => {
    const into = "7a8b9c0d-aaaa-bbbb-cccc-000000000002";
    mergedInto = { id: into };
    await open();
    press("f");
    const box = screen.getByLabelText("Edit the fact");
    fireEvent.change(box, { target: { value: "an existing fact" } });
    press("Enter", box);
    await tick(5000);
    expect((await screen.findByRole("link", { name: "7a8b9c0d" })).getAttribute("href")).toBe(`/facts/${into}`);
  });
});

describe("corrected after citation", () => {
  const C2 = "c2aaaaaa-0000-0000-0000-000000000002";
  const section = () => screen.getByRole("region", { name: "Corrected after citation" });
  const flagged = (id: string) => section().querySelector<HTMLElement>(`li[data-id="${id}"]`);

  beforeEach(() => {
    queue.candidates[1] = candidate(C2);
    queue.flagged = [
      flaggedFact("f1", { correction: { ...flaggedFact("f1").correction, candidate_id: C2 }, replacing: { id: C2, text: `candidate ${C2}` } }),
      flaggedFact("f2"),
    ];
  });

  it("comes after the card, under its own heading", async () => {
    await open();
    expect(within(section()).getByRole("heading", { level: 2, name: "Corrected after citation" })).toBeTruthy();
    expect(card().compareDocumentPosition(section()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card().contains(section())).toBe(false);
  });

  it("shows the fact, when and how it was corrected, and links to the replacing candidate", async () => {
    await open();
    const f1 = flagged("f1")!;
    expect(f1.querySelector(".fact-text")!.textContent).toBe("flagged f1");
    expect(f1.querySelector(".meta")!.textContent).toBe("Convention in Everyone. Corrected 2 hours ago.");
    expect(f1.querySelector(".meta time")!.getAttribute("title")).toBe(when(queue.flagged[0]!.correction.at).title);
    expect(f1.querySelector("blockquote")!.textContent).toBe("no, f1 is wrong");
    expect(f1.querySelector(".help")!.textContent).toBe("Replaced by a new fact: c2aaaaaa");
    expect(within(f1).getByRole("link", { name: "c2aaaaaa" })).toBeTruthy();
    expect(flagged("f2")!.textContent).not.toMatch(/Replaced by/);
  });

  it("the link brings up the replacing candidate's card and focuses it", async () => {
    await open();
    fireEvent.click(within(flagged("f1")!).getByRole("link", { name: "c2aaaaaa" }));
    expect(at()).toBe(`${C2} 2/3`);
    expect(document.activeElement).toBe(card());
    press("j");
    fireEvent.click(within(flagged("f1")!).getByRole("link", { name: "c2aaaaaa" }));
    expect(at()).toBe(`${C2} 2/3`);
    expect(document.activeElement).toBe(card());
  });

  it("names the replacing candidate without a link when it isn't loaded", async () => {
    queue.candidates.splice(1, 1);
    await open();
    expect(flagged("f1")!.querySelector(".help")!.textContent).toBe("Replaced by a new fact: c2aaaaaa");
    expect(within(flagged("f1")!).queryByRole("link")).toBeNull();
  });

  it("Keep curates after the undo window", async () => {
    await open();
    fireEvent.click(within(flagged("f2")!).getByRole("button", { name: "Keep" }));
    expect(flagged("f2")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/^Kept·Undo$/);
    await tick(4900);
    expect(posts("curate")).toEqual([]);
    await tick(200);
    expect(posts("curate")).toEqual([["f2", { action: "keep" }]]);
    expect(posts("review")).toEqual([]);
  });

  it("Fix opens the text; Enter curates a fix with new_text, and under 3 chars does nothing", async () => {
    await open();
    fireEvent.click(within(flagged("f1")!).getByRole("button", { name: "Fix" }));
    const box = within(flagged("f1")!).getByLabelText("Fixed text") as HTMLTextAreaElement;
    expect(box.value).toBe("flagged f1");
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: " x " } });
    press("Enter", box);
    expect(flagged("f1")).not.toBeNull();
    fireEvent.change(box, { target: { value: "  flagged f1, fixed  " } });
    press("Enter", box);
    expect(flagged("f1")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/^Fixed/);
    await tick(5000);
    expect(posts("curate")).toEqual([["f1", { action: "fix", new_text: "flagged f1, fixed" }]]);
  });

  it("Esc closes the fix box without deciding anything", async () => {
    await open();
    fireEvent.click(within(flagged("f1")!).getByRole("button", { name: "Fix" }));
    press("Escape", within(flagged("f1")!).getByLabelText("Fixed text"));
    expect(within(flagged("f1")!).queryByLabelText("Fixed text")).toBeNull();
    await tick(6000);
    expect(posts("curate")).toEqual([]);
  });

  it("Retire asks for an optional note and curates a retire", async () => {
    await open();
    fireEvent.click(within(flagged("f1")!).getByRole("button", { name: "Retire" }));
    const note = within(flagged("f1")!).getByLabelText(/Why retire it/);
    fireEvent.change(note, { target: { value: "wrong since v2" } });
    press("Enter", note);
    expect(screen.getByRole("status").textContent).toMatch(/^Retired/);
    fireEvent.click(within(flagged("f2")!).getByRole("button", { name: "Retire" }));
    fireEvent.click(within(flagged("f2")!).getByRole("button", { name: "Retire fact" }));
    await tick(5000);
    expect(posts("curate")).toEqual([
      ["f1", { action: "retire", note: "wrong since v2" }],
      ["f2", { action: "retire" }],
    ]);
  });

  it("Undo puts the flagged fact back and sends nothing", async () => {
    await open();
    fireEvent.click(within(flagged("f1")!).getByRole("button", { name: "Keep" }));
    expect(flagged("f1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(flagged("f1")).not.toBeNull();
    await tick(10_000);
    expect(posts("curate")).toEqual([]);
  });

  it("a 409 brings the flagged fact back and says why", async () => {
    curateStatus = 409;
    await open();
    fireEvent.click(within(flagged("f1")!).getByRole("button", { name: "Keep" }));
    expect(flagged("f1")).toBeNull();
    await tick(5000);
    expect((await screen.findByRole("alert")).textContent).toMatch(/fact is not active \(409\)/);
    expect(flagged("f1")).not.toBeNull();
  });

  it("a, f and r still act only on candidates", async () => {
    await open();
    press("f");
    expect(card().querySelector("textarea")).not.toBeNull();
    expect(section().querySelector("textarea")).toBeNull();
    press("Escape", screen.getByLabelText("Edit the fact"));
    press("a");
    await tick(5000);
    expect(posts("review")).toEqual([["c1", { action: "approve" }]]);
    expect(posts("curate")).toEqual([]);
    expect(flagged("f1")).not.toBeNull();
  });

  it("shows no section when nothing is flagged", async () => {
    queue.flagged = [];
    await open();
    expect(screen.queryByRole("region", { name: "Corrected after citation" })).toBeNull();
  });

  it("is not empty while a flagged fact is left, and is once both lists are", async () => {
    queue.candidates = [];
    queue.flagged = [flaggedFact("f1")];
    render(<Review role="curator" />);
    await screen.findByText("flagged f1");
    expect(screen.queryByText(/Nothing waiting/)).toBeNull();
    expect(screen.queryByRole("article", { name: "Fact" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("heading", { name: "Nothing waiting for review" })).toBeTruthy();
  });
});

describe("empty and gated", () => {
  const empty = async () => (await screen.findByRole("heading", { name: "Nothing waiting for review" })).closest(".ui-empty")!;

  it("says when Hive last learned from conversations", async () => {
    const at = new Date(Date.now() - 3 * 3600_000).toISOString();
    queue = { candidates: [], flagged: [], last_distill_at: at };
    render(<Review role="curator" />);
    const state = await empty();
    expect(state.querySelector("p")!.textContent).toBe("Hive last learned from conversations 3 hours ago.");
    expect(state.querySelector("time")!.getAttribute("title")).toBe(when(at).title);
  });

  it("says when Hive hasn't learned from any yet", async () => {
    queue = { candidates: [], flagged: [], last_distill_at: null };
    render(<Review role="curator" />);
    expect((await empty()).querySelector("p")!.textContent).toBe("Hive hasn't learned from any conversations yet.");
  });

  it("shows the empty state once the last candidate is decided", async () => {
    queue.candidates = [candidate("c1")];
    await open();
    press("a");
    expect(await empty()).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Fact" })).toBeNull();
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

describe("plain words", () => {
  const ISO = /\d{4}-\d\d-\d\dT\d\d:/;
  const RAW = RAW_VALUES.map((w) => ({ w, re: new RegExp(`\\b${w}\\b`) }));
  /** The first raw API value or ISO date in a visible text node (folded content included), or null. */
  function leak(): string | null {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? "";
      const raw = RAW.find(({ re }) => re.test(t));
      if (raw) return `"${raw.w}" in "${t}"`;
      if (ISO.test(t)) return `"${t}"`;
    }
    return null;
  }

  it("no card shows a raw kind, origin, status, check state or ISO date", async () => {
    const verify = Object.keys(VERIFY);
    const statuses = ["active", "superseded", "retracted", "candidate"];
    queue = {
      candidates: KINDS.map((kind, i) =>
        candidate(`c${i}`, {
          text: `fixture ${i}`,
          kind,
          origin: ORIGINS[i % ORIGINS.length]!,
          scope: i % 2 ? "repo:gh/o/a" : "global",
          replaces: { id: `old-${i}`, text: "old", kind, scope: "global", status: statuses[i % statuses.length]! },
          anchors: verify.map((v, j) =>
            anchorOf({ id: `a${j}`, repo_key: "gh/o/a", path: `src/f${j}.ts`, line_start: 1, quote: "x", verify_status: v, episode_id: j ? null : "e1", source: j ? null : { kind: "turn", author: "Jon", where: "other", at: "2026-10-01T00:00:00Z" } }),
          ),
        }),
      ),
      flagged: KINDS.map((kind, i) => flaggedFact(`f${i}`, { kind })),
      last_distill_at: "2026-10-01T00:00:00Z",
    };
    render(<Review role="curator" />);
    await screen.findByText("fixture 0", { selector: ".proposed" });
    for (let i = 0; i < KINDS.length; i++) {
      expect(leak()).toBeNull();
      press("j");
    }
  });
});
