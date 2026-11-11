import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Team } from "../levels/levels";
import { Teams } from "./Teams";

function team(key: string, over: Partial<Team> = {}): Team {
  return { key, name: key[0]!.toUpperCase() + key.slice(1), created_at: "2026-10-01T00:00:00Z", members: [], repos: [], ...over };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let teams: Team[];
/** Replies to anything but the two GETs; defaults to echoing the matching team back. */
let change: (url: URL, init: RequestInit) => Response;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input), "http://hive");
  const method = init.method ?? "GET";
  if (method === "GET" && url.pathname === "/v1/teams") return json({ teams });
  if (method === "GET" && url.pathname === "/v1/repos") return json({ repos: [{ key: "gh/acme/api" }, { key: "gh/acme/web" }] });
  return change(url, init);
});

/** The non-GET calls so far, as [method, raw path, body]. */
function changes(): [string, string, unknown][] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method && init.method !== "GET")
    .map(([u, init]) => [init!.method!, String(u), init!.body ? JSON.parse(String(init!.body)) : undefined]);
}

const section = (key: string) => document.querySelector(`li[data-key="${key}"]`) as HTMLElement;

beforeEach(() => {
  teams = [
    team("billing", { members: [{ user_id: "ana", role: "member" }, { user_id: "bo", role: "reviewer" }], repos: ["gh/acme/api"] }),
    team("ops"),
  ];
  change = () => json({ error: "not found" }, 404);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open() {
  render(<Teams role="curator" />);
  await screen.findByRole("heading", { name: "Billing" });
}

describe("teams page", () => {
  it("is for curators only", () => {
    render(<Teams role="member" />);
    expect(screen.getByRole("note").textContent).toMatch(/curators only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says when there are no teams yet", async () => {
    teams = [];
    render(<Teams role="curator" />);
    expect(screen.getByText("Loading teams…")).toBeTruthy();
    expect(await screen.findByText("No teams yet.")).toBeTruthy();
  });

  it("shows a load error", async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: "boom" }, 500));
    render(<Teams role="curator" />);
    expect((await screen.findByRole("alert")).textContent).toContain("500");
  });

  it("creates a team, and shows a 409 inline", async () => {
    change = (_url, init) => {
      const body = JSON.parse(String(init.body)) as { key: string; name: string };
      return body.key === "billing" ? json({ error: "team billing already exists" }, 409) : json({ team: team(body.key, { name: body.name }) }, 201);
    };
    await open();
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "billing" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Billing again" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    const form = screen.getByRole("form", { name: "New team" });
    expect((await within(form).findByRole("alert")).textContent).toBe("team billing already exists");

    fireEvent.change(screen.getByLabelText("Key"), { target: { value: " data " } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Data" } });
    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    expect(await screen.findByRole("heading", { name: "Data" })).toBeTruthy();
    expect(changes().at(-1)).toEqual(["POST", "/v1/teams", { key: "data", name: "Data" }]);
    expect(within(form).queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Key") as HTMLInputElement).value).toBe("");
    expect([...document.querySelectorAll("li[data-key]")].map((li) => li.getAttribute("data-key"))).toEqual(["billing", "data", "ops"]);
  });

  it("adds a member as a member", async () => {
    change = () => json({ team: { ...teams[1]!, members: [{ user_id: "cy@x", role: "member" }] } });
    await open();
    const ops = section("ops");
    fireEvent.change(within(ops).getByLabelText("User id"), { target: { value: "cy@x" } });
    fireEvent.click(within(ops).getByRole("button", { name: "Add" }));
    expect(await within(ops).findByText("cy@x")).toBeTruthy();
    expect(changes()).toEqual([["PUT", "/v1/teams/ops/members/cy%40x", { role: "member" }]]);
  });

  it("shows a reviewer's role as text, with no role select anywhere", async () => {
    await open();
    const bo = within(section("billing")).getByText("bo").closest("li")!;
    expect(within(bo).getByText("reviewer").tagName).toBe("SPAN");
    expect(screen.queryAllByRole("combobox").map((s) => s.id)).toEqual(["team-billing-repo", "team-ops-repo"]);
    expect(screen.queryByRole("option", { name: "reviewer" })).toBeNull();
  });

  it("removes a member", async () => {
    change = () => json({ team: { ...teams[0]!, members: [{ user_id: "bo", role: "reviewer" }] } });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Remove ana" }));
    await waitFor(() => expect(within(section("billing")).queryByText("ana")).toBeNull());
    expect(changes()).toEqual([["DELETE", "/v1/teams/billing/members/ana", undefined]]);
  });

  it("attaches a repo from those not attached yet, and detaches one, with the key encoded", async () => {
    change = (url, init) =>
      json({ team: { ...teams[0]!, repos: init.method === "PUT" ? ["gh/acme/api", "gh/acme/web"] : ["gh/acme/web"] } });
    await open();
    const billing = section("billing");
    const pick = within(billing).getByLabelText("Attach repo") as HTMLSelectElement;
    await within(pick).findByRole("option", { name: "gh/acme/web" });
    expect([...pick.options].map((o) => o.value)).toEqual(["", "gh/acme/web"]);
    fireEvent.change(pick, { target: { value: "gh/acme/web" } });
    fireEvent.click(within(billing).getByRole("button", { name: "Attach" }));
    expect(await within(billing).findByRole("button", { name: "Detach gh/acme/web" })).toBeTruthy();
    expect(within(billing).queryByLabelText("Attach repo")).toBeNull();

    fireEvent.click(within(billing).getByRole("button", { name: "Detach gh/acme/api" }));
    await waitFor(() => expect(within(billing).queryByText("gh/acme/api", { selector: "code" })).toBeNull());
    expect(changes()).toEqual([
      ["PUT", "/v1/teams/billing/repos/gh%2Facme%2Fweb", undefined],
      ["DELETE", "/v1/teams/billing/repos/gh%2Facme%2Fapi", undefined],
    ]);
  });

  it("deletes a team after confirming, and shows a 409 under that team", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    change = (url) =>
      url.pathname === "/v1/teams/billing"
        ? json({ error: "team billing still has 3 facts and 1 playbook" }, 409)
        : json({ deleted: "ops" });
    await open();

    fireEvent.click(within(section("billing")).getByRole("button", { name: "Delete team" }));
    expect((await within(section("billing")).findByRole("alert")).textContent).toBe("team billing still has 3 facts and 1 playbook");
    expect(confirmMock).toHaveBeenCalledWith('Delete the team "Billing"?');

    confirmMock.mockReturnValueOnce(false);
    fireEvent.click(within(section("ops")).getByRole("button", { name: "Delete team" }));
    expect(changes()).toHaveLength(1);

    fireEvent.click(within(section("ops")).getByRole("button", { name: "Delete team" }));
    await waitFor(() => expect(section("ops")).toBeNull());
    expect(changes().at(-1)).toEqual(["DELETE", "/v1/teams/ops", undefined]);
  });
});
