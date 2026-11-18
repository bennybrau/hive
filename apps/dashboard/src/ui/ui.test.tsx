import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Status } from "../api";
import { Shell } from "../Shell";
import { Badge, Button, EmptyState, FactRow, Field, Link, PageHeader, Tabs, isCurrent } from ".";

const status = (role: Status["instance"]["role"]): Status => ({ version: "t", instance: { id: "i1", name: "jons-laptop", user_id: "jon", role } });

function json(body: unknown, init: number = 200): Response {
  return new Response(JSON.stringify(body), { status: init, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json({ backlog: { candidates: 0 } }));

beforeEach(() => {
  sessionStorage.setItem("hive.token", "t");
  history.replaceState(null, "", "/");
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json({ backlog: { candidates: 0 } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const menuNames = () => within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link").map((a) => a.textContent);

describe("shell menu", () => {
  it("members get Home, Knowledge, Review and Admin, with no curator group", () => {
    render(<Shell status={status("member")} path="/facts">{null}</Shell>);
    expect(menuNames()).toEqual(["Home", "Knowledge", "Review", "Admin"]);
    expect(screen.queryByText("Curator", { selector: ".group" })).toBeNull();
  });

  it("counts a member's own candidates from their queue, not the stats backlog", async () => {
    fetchMock.mockImplementation(async () => json({ candidates: [{ id: "c1" }, { id: "c2" }], flagged: [], last_distill_at: null }));
    render(<Shell status={status("member")} path="/facts">{null}</Shell>);
    expect((await screen.findByLabelText("2 waiting")).textContent).toBe("2");
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual(["/v1/review/queue?limit=100"]);
  });

  it("workers get no review count fetch", () => {
    render(<Shell status={status("worker")} path="/facts">{null}</Shell>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("curators get Home, Knowledge, then the curator group (Review, Playbooks, Teams), then Admin", () => {
    render(<Shell status={status("curator")} path="/facts">{null}</Shell>);
    expect(menuNames()).toEqual(["Home", "Knowledge", "Review", "Playbooks", "Teams", "Admin"]);
    expect(screen.getByText("Curator", { selector: ".group" })).toBeTruthy();
  });

  it("shows how many facts wait for review, from the stats backlog, and nothing when none wait", async () => {
    fetchMock.mockImplementation(async () => json({ backlog: { candidates: 3 } }));
    const { unmount } = render(<Shell status={status("curator")} path="/facts">{null}</Shell>);
    expect((await screen.findByLabelText("3 waiting")).textContent).toBe("3");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/v1/stats?days=1");
    unmount();

    fetchMock.mockImplementation(async () => json({ backlog: { candidates: 0 } }));
    render(<Shell status={status("curator")} path="/facts">{null}</Shell>);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20)); // let the answer land
    expect(screen.queryByLabelText(/waiting/)).toBeNull();
    expect(screen.getByRole("link", { name: "Review" }).textContent).toBe("Review");
  });

  it("re-reads the count when the page changes", async () => {
    const { rerender } = render(<Shell status={status("curator")} path="/review">{null}</Shell>);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<Shell status={status("curator")} path="/facts">{null}</Shell>);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("a failing count call leaves the menu as it is", async () => {
    fetchMock.mockImplementation(async () => json({ error: "nope" }, 500));
    render(<Shell status={status("curator")} path="/facts">{null}</Shell>);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/waiting/)).toBeNull();
  });

  it.each([
    ["/facts", "Knowledge", "Facts"],
    ["/facts/abc", "Knowledge", "Facts"],
    ["/search", "Knowledge", "Search"],
    ["/review", "Review", "New"],
    ["/stale", "Review", "Out of date"],
    ["/repos", "Admin", "Sources"],
    ["/stats", "Admin", "Usage and cost"],
    ["/settings", "Admin", "Notifications"],
  ])("on %s the %s item and its %s tab are current", (path, item, tab) => {
    render(<Shell status={status("curator")} path={path}>{null}</Shell>);
    const main = screen.getByRole("navigation", { name: "Main" });
    const current = within(main).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent)).toEqual([item]);
    const tabs = screen.getByRole("navigation", { name: `${item} pages` });
    expect(within(tabs).getByRole("link", { name: tab }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText(item, { selector: ".topbar .where" })).toBeTruthy();
  });

  it("on / only Home is current, with no tabs", () => {
    render(<Shell status={status("member")} path="/">{null}</Shell>);
    const main = screen.getByRole("navigation", { name: "Main" });
    const current = within(main).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Home", "/"]]);
    expect(screen.queryByRole("navigation", { name: "Home pages" })).toBeNull();
    expect(screen.getByText("Home", { selector: ".topbar .where" })).toBeTruthy();
  });

  it("sections with one page show no tabs, and a member's Admin is just Sources", () => {
    const { unmount } = render(<Shell status={status("curator")} path="/teams">{null}</Shell>);
    expect(screen.queryByRole("navigation", { name: "Teams pages" })).toBeNull();
    unmount();
    render(<Shell status={status("member")} path="/repos">{null}</Shell>);
    expect(screen.queryByRole("navigation", { name: "Admin pages" })).toBeNull();
    expect(screen.getByRole("link", { name: "Admin" }).getAttribute("href")).toBe("/repos");
  });

  it("an address outside every section marks nothing current", () => {
    render(<Shell status={status("curator")} path="/nowhere">{null}</Shell>);
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("link").some((a) => a.getAttribute("aria-current"))).toBe(false);
    expect(screen.getByText("Hive", { selector: ".topbar .where" })).toBeTruthy();
  });

  it("the phone Menu button says whether the menu is open, and changing page closes it", () => {
    const { container, rerender } = render(<Shell status={status("curator")} path="/facts">{null}</Shell>);
    const btn = screen.getByRole("button", { name: "Menu" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe("sidebar");
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: "Close" }).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".app")!.classList.contains("menu-open")).toBe(true);
    rerender(<Shell status={status("curator")} path="/review">{null}</Shell>);
    expect(screen.getByRole("button", { name: "Menu" }).getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".app")!.classList.contains("menu-open")).toBe(false);
  });

  it("shows the person and role, and the token name in the account panel", () => {
    render(<Shell status={status("curator")} path="/facts">{null}</Shell>);
    expect(screen.getByText("jon", { selector: ".who b" })).toBeTruthy();
    expect(screen.getByLabelText("role").textContent).toBe("Curator");
    expect(screen.getByText("jons-laptop").closest(".panel")).toBeTruthy();
  });

  it("has a skip link to the page content as the first thing", () => {
    const { container } = render(<Shell status={status("member")} path="/facts"><p>page</p></Shell>);
    const first = container.querySelector("a")!;
    expect(first.textContent).toBe("Skip to content");
    expect(first.getAttribute("href")).toBe("#main");
    expect(container.querySelector("#main")!.textContent).toContain("page");
  });

  it("menu links navigate inside the app", () => {
    render(<Shell status={status("curator")} path="/facts">{null}</Shell>);
    fireEvent.click(screen.getByRole("link", { name: "Teams" }));
    expect(location.pathname).toBe("/teams");
  });
});

describe("ui components", () => {
  it("Button defaults to type=button and maps variants to classes", () => {
    render(
      <>
        <Button>One</Button>
        <Button variant="primary" big>
          Two
        </Button>
        <Button variant="quiet" type="submit">
          Three
        </Button>
      </>,
    );
    const [one, two, three] = screen.getAllByRole("button");
    expect(one!.getAttribute("type")).toBe("button");
    expect(one!.className).toBe("btn");
    expect(two!.className).toBe("btn primary big");
    expect(three!.getAttribute("type")).toBe("submit");
    expect(three!.className).toBe("btn quiet");
  });

  it("Link navigates on a plain click and leaves modified clicks to the browser", () => {
    render(<Link to="/teams">Teams</Link>);
    const a = screen.getByRole("link", { name: "Teams" });
    expect(fireEvent.click(a, { metaKey: true })).toBe(true); // not prevented
    expect(location.pathname).toBe("/");
    expect(fireEvent.click(a)).toBe(false); // prevented
    expect(location.pathname).toBe("/teams");
  });

  it("Field labels its control and points it at the help line, or at the error instead", () => {
    const { rerender } = render(<Field label="Send to" help="An email address">{(p) => <input {...p} />}</Field>);
    const input = screen.getByLabelText("Send to");
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toBe("An email address");
    expect(input.getAttribute("aria-invalid")).toBeNull();

    rerender(
      <Field label="Send to" help="An email address" error="That isn't an email address">
        {(p) => <input {...p} />}
      </Field>,
    );
    const again = screen.getByLabelText("Send to");
    expect(again.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(again.getAttribute("aria-describedby")!)!.textContent).toBe("That isn't an email address");
    expect(screen.getByRole("alert").textContent).toBe("That isn't an email address");
    expect(screen.queryByText("An email address")).toBeNull();

    rerender(<Field label="Send to">{(p) => <input {...p} />}</Field>);
    expect(screen.getByLabelText("Send to").getAttribute("aria-describedby")).toBeNull();
  });

  it("Tabs mark the current one and show counts", () => {
    render(
      <Tabs
        label="Results"
        path="/facts/x"
        tabs={[
          { to: "/facts", label: "Facts", match: (p) => p.startsWith("/facts"), count: 4 },
          { to: "/docs", label: "Docs", count: 0 },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Results" });
    const [facts, docs] = within(nav).getAllByRole("link");
    expect(facts!.getAttribute("aria-current")).toBe("page");
    expect(facts!.textContent).toBe("Facts4");
    expect(docs!.getAttribute("aria-current")).toBeNull();
    expect(docs!.textContent).toBe("Docs0");
    expect(isCurrent({ to: "/docs" }, "/docs")).toBe(true);
    expect(isCurrent({ to: "/docs" }, "/docs/1")).toBe(false);
  });

  it("PageHeader, EmptyState and Badge render their parts", () => {
    render(
      <>
        <PageHeader title="Knowledge" lede="Every fact agents are given." action={<Button variant="primary">Add a fact</Button>} />
        <EmptyState title="No teams yet">A team's agents get its facts first.</EmptyState>
        <Badge tone="who">Repo: hive</Badge>
      </>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Knowledge" })).toBeTruthy();
    expect(screen.getByText("Every fact agents are given.").className).toBe("lede");
    expect(screen.getByRole("heading", { level: 2, name: "No teams yet" })).toBeTruthy();
    expect(screen.getByText("Repo: hive").className).toBe("ui-badge who");
  });

  it("FactRow is one link: the text, then the badge, the meta phrase and the use count", () => {
    const { rerender } = render(
      <FactRow href="/facts/f1" text="Retry twice." badge={<Badge tone="who">Repo: hive</Badge>} meta="Convention, 2 hours ago" used="Used 5 times" data-id="f1" />,
    );
    const row = screen.getByRole("link", { name: "Retry twice. Repo: hive Convention, 2 hours ago Used 5 times" });
    expect(row.className).toBe("fact-row");
    expect(row.getAttribute("href")).toBe("/facts/f1");
    expect(row.dataset.id).toBe("f1");
    expect(row.getAttribute("aria-current")).toBeNull();
    expect(row.querySelector(".text")!.textContent).toBe("Retry twice.");
    expect(row.querySelector(".used")!.textContent).toBe("Used 5 times");

    rerender(<FactRow href="/facts/f1" text="Retry twice." meta="Convention" current />);
    const open = screen.getByRole("link", { name: "Retry twice. Convention" });
    expect(open.getAttribute("aria-current")).toBe("true");
    expect(open.querySelector(".used")).toBeNull();
    fireEvent.click(open);
    expect(location.pathname).toBe("/facts/f1");
  });
});
