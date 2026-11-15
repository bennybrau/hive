import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fact } from "../facts/query";
import { RAW_VALUES } from "../words";
import { Home, type HomeData } from "./Home";

const NOW = Date.parse("2026-11-12T15:00:00Z");
const HOURS_AGO = new Date(NOW - 2 * 3600_000).toISOString();
const MINUTES_AGO = new Date(NOW - 3 * 60_000).toISOString();

function fact(id: string, over: Partial<Fact> = {}): Fact {
  return {
    id, text: `fact ${id}`, kind: "decision", locus: [], origin: "authored", status: "active", status_note: null,
    author_user_id: "jon", recorded_at: HOURS_AGO, scope: "global", level: "organisation", use_count: 3, last_used_at: null,
    ...over,
  };
}

function member(over: Partial<HomeData> = {}): HomeData {
  return {
    facts: {
      live: 62,
      by_level: [
        { scope: "repo:gh/acme/hive", count: 40 },
        { scope: "personal", count: 10 },
        { scope: "team:billing", count: 8 },
        { scope: "global", count: 4 },
      ],
    },
    recent: [
      fact("f1", { kind: "convention", scope: "repo:gh/acme/hive", level: "repository", use_count: 0 }),
      fact("f2", { scope: "team:billing", level: "team", team: "billing", team_name: "Billing", own_team: true, use_count: 1 }),
      fact("f3"),
    ],
    repos: { count: 3, last_read_at: MINUTES_AGO, problems: 0 },
    teams: { count: 0 },
    ...over,
  };
}

function curator(over: Partial<HomeData> = {}): HomeData {
  return {
    ...member(),
    waiting: 0,
    waiting_latest_at: null,
    out_of_date: 0,
    stale_days: 60,
    month: { cost_usd: 8.5712, conversations: 202, proposed: 187 },
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let home: () => Response;
let teamsOk: boolean;
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const path = String(input);
  if (path === "/v1/home") return home();
  if (path === "/v1/teams") return teamsOk ? json({ teams: [{ key: "billing", name: "Billing", created_at: HOURS_AGO, members: [], repos: [] }] }) : json({ error: "no" }, 500);
  if (path === "/v1/teams/mine") return json({ teams: [] });
  return json({ error: "not found" }, 404);
});
const homeCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === "/v1/home").length;

function show(data: HomeData, role: "member" | "curator" = data.waiting === undefined ? "member" : "curator") {
  home = () => json(data);
  return render(<Home name="jon" role={role} />);
}

const needs = () => screen.queryByRole("region", { name: "Needs you" });
const todos = () => [...needs()!.querySelectorAll(".todo")] as HTMLElement[];
const primaries = () => document.querySelectorAll(".btn.primary");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  teamsOk = true;
  sessionStorage.setItem("hive.token", "t");
  history.replaceState(null, "", "/");
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("Home header", () => {
  it.each([
    [4, "Good evening, Jon"],
    [5, "Good morning, Jon"],
    [11, "Good morning, Jon"],
    [12, "Good afternoon, Jon"],
    [17, "Good afternoon, Jon"],
    [18, "Good evening, Jon"],
  ])("at %i:30 it says %s", async (hour, text) => {
    vi.setSystemTime(Date.UTC(2026, 10, 12, hour, 30));
    show(member());
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(text);
    expect(screen.getByText("Hive is your team's shared memory. Agents are given what's here before they start work.")).toBeTruthy();
    await screen.findByText("What Hive knows");
  });

  it("says so when Home can't be loaded", async () => {
    home = () => json({ error: "boom" }, 500);
    render(<Home name="jon" role="member" />);
    expect((await screen.findByRole("alert")).textContent).toBe("The hive answered 500.");
  });
});

describe("Needs you", () => {
  it("a member sees no Needs you, no cost and no button to create a team", async () => {
    show(member());
    await screen.findByText("What Hive knows");
    expect(needs()).toBeNull();
    expect(screen.queryByText("This month")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$/);
    expect(screen.queryByRole("link", { name: "Create a team" })).toBeNull();
    expect(primaries()).toHaveLength(0);
  });

  it("goes by the role, not by which keys came back", async () => {
    show(curator({ waiting: 2 }), "member");
    await screen.findByText("What Hive knows");
    expect(needs()).toBeNull();
    expect(screen.queryByText("This month")).toBeNull();
  });

  it("nothing waiting: the review line is plain, with Open Review and no primary button", async () => {
    show(curator());
    await screen.findByText("Needs you");
    const [review] = todos();
    expect(review!.dataset.state).toBeUndefined();
    expect(within(review!).getByText("Nothing is waiting for review.")).toBeTruthy();
    expect(within(review!).getByText("Hive proposes a fact when someone corrects an agent. Agents don't get it until a curator approves.")).toBeTruthy();
    const open = within(review!).getByRole("link", { name: "Open Review" });
    expect(open.getAttribute("href")).toBe("/review");
    expect(open.className).toBe("btn");
    expect(primaries()).toHaveLength(0);
    expect(document.querySelectorAll("[data-state=waiting]")).toHaveLength(0);
  });

  it("facts waiting: the review line takes the tint and the page's one primary button", async () => {
    show(curator({ waiting: 2, waiting_latest_at: HOURS_AGO }));
    await screen.findByText("Needs you");
    const [review] = todos();
    expect(review!.dataset.state).toBe("waiting");
    expect(review!.querySelector(".what")!.textContent).toBe("2 facts are waiting for review.");
    expect(review!.querySelector(".what b")!.textContent).toBe("2 facts");
    expect(review!.querySelector(".why")!.textContent).toBe("The newest is from 2 hours ago. Agents don't get them until you approve.");
    expect(primaries()).toHaveLength(1);
    const btn = within(review!).getByRole("link", { name: "Review 2 facts" });
    expect(btn).toBe(primaries()[0]);
    expect(btn.getAttribute("href")).toBe("/review");
    expect(document.querySelectorAll("[data-state=waiting]")).toHaveLength(1);
  });

  it("one fact waiting is singular", async () => {
    show(curator({ waiting: 1, waiting_latest_at: HOURS_AGO }));
    await screen.findByText("Needs you");
    const [review] = todos();
    expect(review!.querySelector(".what")!.textContent).toBe("1 fact is waiting for review.");
    expect(review!.querySelector(".why")!.textContent).toBe("It is from 2 hours ago. Agents don't get it until you approve.");
    expect(within(review!).getByRole("link", { name: "Review 1 fact" })).toBeTruthy();
  });

  it("out of date: a count, or none, with the stale days and See the list", async () => {
    const { unmount } = show(curator({ out_of_date: 4, stale_days: 30 }));
    await screen.findByText("Needs you");
    let stale = todos()[1]!;
    expect(stale.querySelector(".what")!.textContent).toBe("4 facts may be out of date.");
    expect(stale.querySelector(".why")!.textContent).toBe("A fact nobody has used in 30 days shows up here, so you can keep it or retire it.");
    const link = within(stale).getByRole("link", { name: "See the list" });
    expect(link.getAttribute("href")).toBe("/stale");
    expect(link.className).toBe("btn quiet");
    unmount();

    show(curator({ out_of_date: 1 }));
    await screen.findByText("Needs you");
    expect(todos()[1]!.querySelector(".what")!.textContent).toBe("1 fact may be out of date.");
    cleanup();

    show(curator());
    await screen.findByText("Needs you");
    stale = todos()[1]!;
    expect(stale.querySelector(".what")!.textContent).toBe("No facts look out of date.");
    expect(stale.querySelector(".why")!.textContent).toContain("in 60 days");
  });

  it.each([
    [{ count: 3, last_read_at: MINUTES_AGO, problems: 0 }, "3 repos read 3 minutes ago, no problems.", true],
    [{ count: 1, last_read_at: MINUTES_AGO, problems: 0 }, "1 repo read 3 minutes ago, no problems.", true],
    [{ count: 3, last_read_at: MINUTES_AGO, problems: 1 }, "1 of 3 repos couldn't be read.", false],
    [{ count: 3, last_read_at: null, problems: 0 }, "3 repos haven't been read yet.", false],
    [{ count: 1, last_read_at: null, problems: 0 }, "1 repo hasn't been read yet.", false],
    [{ count: 0, last_read_at: null, problems: 0 }, "Hive isn't reading any repos yet.", false],
  ])("sources %j: %s", async (repos, text, dot) => {
    show(curator({ repos }));
    await screen.findByText("Needs you");
    const sources = todos()[2]!;
    expect(sources.querySelector(".what")!.textContent).toBe(text);
    expect(!!sources.querySelector(".dot")).toBe(dot);
    expect(sources.querySelector(".why")!.textContent).toBe("Hive reads each repo's docs and commits so agents can search them.");
    const link = within(sources).getByRole("link", { name: "Check sources" });
    expect(link.getAttribute("href")).toBe("/repos");
    expect(link.className).toBe("btn quiet");
  });
});

describe("What Hive knows", () => {
  it("one bar per level, as wide as its share of the largest, each linking to Facts at that level", async () => {
    show(member());
    await screen.findByText("What Hive knows");
    expect(document.querySelector(".sub")!.textContent).toBe("62 live facts, by who gets them");
    const rows = [...document.querySelectorAll<HTMLAnchorElement>(".lvl")];
    expect(rows.map((r) => r.querySelector(".name")!.firstChild!.textContent!.trim())).toEqual(["Repo: hive", "Just me", "Team: Billing", "Everyone"]);
    expect(rows.map((r) => r.querySelector(".hint")!.textContent)).toEqual([
      "Agents working in the hive repo.",
      "Only your own agents.",
      "This team first; others can still find it.",
      "Agents in every repository, for every team.",
    ]);
    expect(rows.map((r) => r.querySelector<HTMLElement>(".fill")!.style.width)).toEqual(["100%", "25%", "20%", "10%"]);
    expect(rows.map((r) => r.querySelector(".n")!.textContent)).toEqual(["40", "10", "8", "4"]);
    expect(rows.map((r) => r.getAttribute("href"))).toEqual([
      "/facts?level=repository&repo=gh%2Facme%2Fhive",
      "/facts?level=personal",
      "/facts?level=team%3Abilling",
      "/facts?level=global",
    ]);
    fireEvent.click(rows[1]!);
    expect(location.pathname + location.search).toBe("/facts?level=personal");
  });

  it("a team shows its key when the teams can't be loaded", async () => {
    teamsOk = false;
    show(member());
    await screen.findByText("What Hive knows");
    expect(document.querySelectorAll(".lvl .name")[2]!.firstChild!.textContent!.trim()).toBe("Team: billing");
  });

  it("Teams: none, with Create a team for a curator; some, with See teams for a curator", async () => {
    const { unmount } = show(curator());
    await screen.findByText("What Hive knows");
    const none = "No teams yet. A team's agents get its facts before anyone else's, so Billing hears Billing's rules first.";
    expect(screen.getByText(none)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create a team" }).getAttribute("href")).toBe("/teams");
    unmount();

    const again = show(curator({ teams: { count: 3 } }));
    await screen.findByText("What Hive knows");
    expect(screen.getByText("3 teams.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See teams" }).getAttribute("href")).toBe("/teams");
    expect(screen.queryByText(none)).toBeNull();
    again.unmount();

    show(member({ teams: { count: 1 } }));
    await screen.findByText("What Hive knows");
    expect(screen.getByText("1 team.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "See teams" })).toBeNull();
  });

  it("This month: the cost in one sentence, with a link to Usage and cost", async () => {
    const { unmount } = show(curator());
    await screen.findByText("This month");
    const p = screen.getByText(/to learn from/);
    expect(p.textContent).toBe("$8.57 to learn from 202 conversations, which proposed 187 facts. Searching and looking facts up cost nothing.");
    expect(p.querySelector("b")!.textContent).toBe("$8.57");
    expect(screen.getByRole("link", { name: "See usage and cost" }).getAttribute("href")).toBe("/stats");
    unmount();

    show(curator({ month: { cost_usd: 0, conversations: 1, proposed: 1 } }));
    expect((await screen.findByText(/to learn from/)).textContent).toBe(
      "$0.00 to learn from 1 conversation, which proposed 1 fact. Searching and looking facts up cost nothing.",
    );
  });
});

describe("Recently added", () => {
  it("the newest facts as FactRows linking to each fact, then All <live> facts", async () => {
    show(member());
    const section = await screen.findByRole("region", { name: "Recently added" });
    const rows = [...section.querySelectorAll<HTMLAnchorElement>(".fact-row")];
    expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/facts/f1", "/facts/f2", "/facts/f3"]);
    expect(rows.map((r) => r.querySelector(".ui-badge")!.textContent)).toEqual(["Repo: hive", "Team: Billing", "Everyone"]);
    expect(rows[0]!.querySelector(".meta")!.textContent).toBe("Repo: hive Convention, 2 hours ago Not used yet");
    expect(rows.map((r) => r.querySelector(".used")!.textContent)).toEqual(["Not used yet", "Used once", "Used 3 times"]);
    expect(within(section).getByRole("link", { name: "All 62 facts" }).getAttribute("href")).toBe("/facts");
  });
});

describe("an empty Hive", () => {
  it("says what Hive doesn't know yet, and how facts get here, with no bars and no Recently added", async () => {
    show(curator({ facts: { live: 0, by_level: [] }, recent: [] }));
    expect(await screen.findByRole("heading", { name: "Hive doesn't know anything yet" })).toBeTruthy();
    expect(
      screen.getByText("Hive proposes a fact when someone corrects an agent, and reads each repo's docs. Facts show up here once they're live."),
    ).toBeTruthy();
    expect(document.querySelectorAll(".lvl")).toHaveLength(0);
    expect(document.querySelector(".sub")).toBeNull();
    expect(screen.queryByRole("region", { name: "Recently added" })).toBeNull();
    expect(screen.getByText("Teams")).toBeTruthy();
    expect(needs()).not.toBeNull();
  });
});

describe("refreshing", () => {
  it("reads Home again when the tab comes back into view, and doesn't poll", async () => {
    show(curator());
    await screen.findByText("Needs you");
    expect(homeCalls()).toBe(1);

    home = () => json(curator({ waiting: 3, waiting_latest_at: HOURS_AGO }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(homeCalls()).toBe(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByRole("link", { name: "Review 3 facts" })).toBeTruthy();
    expect(homeCalls()).toBe(2);
    delete (document as { visibilityState?: unknown }).visibilityState;
  });
});

describe("plain words", () => {
  it("shows no raw API value as text, for a curator with everything", async () => {
    show(curator({ waiting: 2, waiting_latest_at: HOURS_AGO, out_of_date: 4, teams: { count: 2 } }));
    await screen.findByText("Recently added");
    const text = document.body.textContent!;
    for (const raw of [...RAW_VALUES, "personal", "repo:", "team:"]) expect(text).not.toMatch(new RegExp(`\\b${raw}\\b`));
    expect(text).not.toMatch(/\d{4}-\d\d-\d\dT/);
  });
});
