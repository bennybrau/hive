import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { Stats, type StatsBody } from "./Stats";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

let stats: StatsBody;
let role: string;

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://hive");
  if (url.pathname === "/v1/stats") return json({ ...stats, days: Number(url.searchParams.get("days")) });
  if (url.pathname === "/v1/status") {
    return json({ version: "test", instance: { id: "i1", name: "jon-mac", user_id: "jon", role } });
  }
  return json({ candidates: [], last_distill_at: null, facts: [], total: 0 });
});

const statsCalls = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/v1/stats"));
const cells = (table: string) =>
  within(screen.getByRole("table", { name: table }))
    .getAllByRole("row")
    .map((r) => within(r).queryAllByRole("cell").map((c) => c.textContent))
    .filter((r) => r.length > 0);

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  role = "curator";
  stats = {
    days: 30,
    since: "2026-10-04T00:00:00.000Z",
    facts: {
      by_status: { active: 5, candidate: 2 },
      by_origin: { authored: 4, distilled: 3 },
      by_scope: { global: 3, personal: 4, "repo:gh/a/b": 1 },
      per_day: [{ day: "2026-11-01", count: 7 }],
    },
    cost: [
      { day: "2026-11-01", job: "distill", calls: 2, input_tokens: 12000, output_tokens: 800, cost_usd: 0.4567 },
      { day: "2026-11-01", job: "embed", calls: 9, input_tokens: 300, output_tokens: 0, cost_usd: 0 },
    ],
    cost_totals: [
      { job: "distill", calls: 2, input_tokens: 12000, output_tokens: 800, cost_usd: 0.4567 },
      { job: "embed", calls: 9, input_tokens: 300, output_tokens: 0, cost_usd: 0 },
    ],
    workers: [
      { id: "w1", name: "worker-fresh", last_seen_at: minutesAgo(2) },
      { id: "w2", name: "worker-old", last_seen_at: minutesAgo(30) },
      { id: "w3", name: "worker-never", last_seen_at: null },
    ],
    backlog: { candidates: 2, oldest_candidate_at: minutesAgo(120), distill_queued: 1, oldest_queued_at: minutesAgo(5) },
  };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("stats page", () => {
  it("shows cost, facts, workers and backlog tables", async () => {
    render(<Stats role="curator" />);
    await screen.findByRole("table", { name: "Cost by job" });
    expect(statsCalls()).toEqual(["/v1/stats?days=30"]);
    expect(cells("Cost by job")).toEqual([
      ["Learning from conversations", "2", "12,000", "800", "$0.46"],
      ["Indexing for search", "9", "300", "0", "$0.00"],
    ]);
    expect(cells("Cost by day")[1]).toEqual(["Nov 1", "Indexing for search", "9", "300", "0", "$0.00"]);
    expect(cells("Status")).toEqual([
      ["Live", "5"],
      ["Waiting for review", "2"],
    ]);
    expect(cells("Origin")).toEqual([
      ["Written by a person", "4"],
      ["Learned from a conversation", "3"],
    ]);
    expect(cells("Who gets it")).toEqual([
      ["Everyone", "3"],
      ["Just me", "4"],
      ["Repo: b", "1"],
    ]);
    expect(cells("Facts by day")).toEqual([["Nov 1", "7"]]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Usage and cost");
    expect(screen.getByText("Facts waiting for review")).toBeTruthy();
    expect(screen.getByText("Conversations waiting to be read")).toBeTruthy();
    expect(cells("Backlog")).toEqual([
      ["2", "oldest 2 hours ago"],
      ["1", "oldest 5 minutes ago"],
    ]);
  });

  it("flags workers not seen for 10 minutes, or never", async () => {
    render(<Stats role="curator" />);
    const table = await screen.findByRole("table", { name: "Workers" });
    const stale = within(table)
      .getAllByRole("row")
      .filter((r) => within(r).queryByText("Not running?"))
      .map((r) => within(r).getAllByRole("cell")[0]!.textContent);
    expect(stale).toEqual(["worker-old", "worker-never"]);
    expect(cells("Workers").map((c) => c[1])).toEqual(["2 minutes ago ", "30 minutes ago Not running?", "Never Not running?"]);
  });

  it("switching the window refetches", async () => {
    render(<Stats role="curator" />);
    await screen.findByRole("table", { name: "Cost by job" });
    const seven = screen.getByRole("button", { name: "7 days" });
    expect(seven.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "30 days" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(seven);
    expect(seven.getAttribute("aria-pressed")).toBe("true");
    await vi.waitFor(() => expect(statsCalls()).toEqual(["/v1/stats?days=30", "/v1/stats?days=7"]));
  });

  it("shows empty-state messages when there is nothing in the window", async () => {
    stats = {
      days: 30,
      since: "2026-10-04T00:00:00.000Z",
      facts: { by_status: {}, by_origin: {}, by_scope: {}, per_day: [] },
      cost: [],
      cost_totals: [],
      workers: [],
      backlog: { candidates: 0, oldest_candidate_at: null, distill_queued: 0, oldest_queued_at: null },
    };
    render(<Stats role="curator" />);
    await screen.findByText("No LLM calls in this window.");
    expect(screen.getByText("No facts recorded in this window.")).toBeDefined();
    expect(screen.getByText("No worker tokens.")).toBeDefined();
    expect(cells("Backlog")).toEqual([
      ["0", ""],
      ["0", ""],
    ]);
  });

  it("shows an alert when the stats request fails", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("", { status: 500 }));
    render(<Stats role="curator" />);
    expect((await screen.findByRole("alert")).textContent).toBe("The hive answered 500.");
  });

  it("tells a member it's for a Curator and doesn't fetch", () => {
    render(<Stats role="member" />);
    expect(screen.getByRole("note").textContent).toBe("Only a Curator can see usage and cost.");
    expect(screen.getByRole("note").title).toBe("Approves what Hive learns before agents get it");
    expect(statsCalls()).toEqual([]);
  });

  it("shows Admin's Usage and cost tab to curators only", async () => {
    sessionStorage.setItem("hive.token", "t");
    role = "member";
    history.replaceState(null, "", "/repos");
    const { unmount } = render(<App />);
    await screen.findByText("jon-mac");
    expect(screen.queryByRole("link", { name: "Usage and cost" })).toBeNull();
    unmount();

    role = "curator";
    history.replaceState(null, "", "/stats");
    render(<App />);
    await screen.findByRole("table", { name: "Cost by job" });
    expect(screen.getByRole("link", { name: "Usage and cost" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Admin" }).getAttribute("aria-current")).toBe("page");
  });
});
