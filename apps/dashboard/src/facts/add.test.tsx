import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Facts } from "./Facts";
import type { Fact } from "./query";

function fact(id: string, over: Partial<Fact> = {}): Fact {
  return {
    id,
    text: `fact ${id}`,
    kind: "gotcha",
    scope: "global",
    locus: [],
    origin: "authored",
    status: "active",
    status_note: null,
    author_user_id: "u1",
    recorded_at: "2026-10-01T12:00:00Z",
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const TEAMS = [
  { key: "billing", name: "Billing", created_at: "2026-10-01T00:00:00Z", members: [], repos: [] },
  { key: "ops", name: "Ops", created_at: "2026-10-01T00:00:00Z", members: [], repos: [] },
];

// A small hive: the facts, who is signed in, and what the next add answers.
let facts: Map<string, Fact>;
let me: { role: string; user_id: string };
let fail: { status: number; body: unknown } | null;
let next: number;
const posts: { path: string; body: unknown }[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  const path = url.pathname;
  if (path === "/v1/status") return json({ version: "1", instance: { id: "i1", name: "me", ...me } });
  if (path === "/v1/repos") return json({ repos: [{ key: "acme/widgets" }] });
  if (path === "/v1/repo-keys") return json({ repo_keys: ["acme/widgets", "acme/other"] });
  if (path === "/v1/teams") return json({ teams: TEAMS });
  if (path === "/v1/teams/mine") return json({ teams: [{ key: "billing", name: "Billing", role: "member" }] });
  if (path === "/v1/facts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { text: string; kind: string; scope: string };
    posts.push({ path, body });
    if (fail) return json(fail.body, fail.status);
    const same = [...facts.values()].find((f) => f.text === body.text);
    if (same) return json({ fact: same, deduped: true }, 200);
    const scope = body.scope === "personal" ? `personal:${me.user_id}` : body.scope;
    const shared = !scope.startsWith("personal:");
    const f = fact(`n${next++}`, {
      text: body.text,
      kind: body.kind,
      scope,
      author_user_id: me.user_id,
      status: shared && me.role !== "curator" ? "candidate" : "active",
    });
    facts.set(f.id, f);
    return json({ fact: f, deduped: false }, 201);
  }
  if (path === "/v1/facts") {
    const status = url.searchParams.get("status") ?? "active";
    const kind = url.searchParams.get("kind");
    const list = [...facts.values()].filter((f) => f.status === status && (!kind || f.kind === kind)).reverse();
    return json({ facts: list, has_more: false, total: list.length });
  }
  const m = /^\/v1\/facts\/([^/]+)$/.exec(path);
  const f = m && facts.get(m[1]!);
  if (!f) return json({ error: "no such fact" }, 404);
  return json({ fact: f, anchors: [], reviews: [], supersedes: [], superseded_by: [] });
});

const primaries = () => document.querySelectorAll(".btn.primary").length;
const header = () => document.querySelector(".ui-page-head") as HTMLElement;
const form = () => screen.findByRole("complementary", { name: "Add a fact" });
const list = () => document.querySelector(".kn-list") as HTMLElement;
const listTexts = () => [...(list()?.querySelectorAll("[data-id]") ?? [])].map((r) => (r as HTMLElement).dataset.id);
const add = (p: HTMLElement) => within(p).getByRole("button", { name: "Add this fact" }) as HTMLButtonElement;
const box = (p: HTMLElement) => within(p).getByRole("textbox", { name: "The fact" }) as HTMLTextAreaElement;
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/** Opens the list with a filter in the URL, then Add a fact from the header. */
async function openForm() {
  history.replaceState(null, "", "/facts?kind=gotcha");
  render(<Facts />);
  await waitFor(() => expect(listTexts().length).toBeGreaterThan(0));
  fireEvent.click(within(header()).getByRole("button", { name: "Add a fact" }));
  const p = await form();
  await settle();
  return p;
}

beforeEach(() => {
  facts = new Map([["f1", fact("f1", { text: "a live fact" })]]);
  me = { role: "curator", user_id: "c1" };
  fail = null;
  next = 1;
  posts.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Add a fact", () => {
  it("opens at /facts/new with the filters kept, Just me and Decision chosen, and the header button gone", async () => {
    const p = await openForm();
    expect(location.pathname).toBe("/facts/new");
    expect(location.search).toBe("?kind=gotcha");
    expect(document.querySelector("main")!.className).toBe("page kn view-fact");
    expect(within(header()).queryByRole("button", { name: "Add a fact" })).toBeNull();
    expect(within(p).getByRole("radio", { name: "Just me" })).toHaveProperty("checked", true);
    expect((within(p).getByRole("combobox", { name: "Kind" }) as HTMLSelectElement).value).toBe("decision");
    expect(within(p).queryByText(/\(current\)/)).toBeNull();
  });

  it("sends Just me as personal, with the trimmed text and the kind", async () => {
    const p = await openForm();
    fireEvent.change(box(p), { target: { value: "  run the migrations first  " } });
    fireEvent.change(within(p).getByRole("combobox", { name: "Kind" }), { target: { value: "gotcha" } });
    fireEvent.click(add(p));
    await waitFor(() => expect(posts).toEqual([{ path: "/v1/facts", body: { text: "run the migrations first", kind: "gotcha", scope: "personal" } }]));
  });

  it("sends a repo picked under A repo…", async () => {
    const p = await openForm();
    fireEvent.change(box(p), { target: { value: "widgets builds with make" } });
    fireEvent.change(within(p).getByRole("combobox", { name: "A repo" }), { target: { value: "acme/other" } });
    fireEvent.click(add(p));
    await waitFor(() => expect(posts).toEqual([{ path: "/v1/facts", body: { text: "widgets builds with make", kind: "decision", scope: "repo:acme/other" } }]));
  });

  it("sends a team", async () => {
    const p = await openForm();
    fireEvent.change(box(p), { target: { value: "billing deploys on tuesdays" } });
    fireEvent.click(within(p).getByRole("radio", { name: "Team: Ops" }));
    fireEvent.click(add(p));
    await waitFor(() => expect(posts).toEqual([{ path: "/v1/facts", body: { text: "billing deploys on tuesdays", kind: "decision", scope: "team:ops" } }]));
  });

  it("needs the fact: under 3 characters shows an error under the box and sends nothing", async () => {
    const p = await openForm();
    fireEvent.change(box(p), { target: { value: "  ab  " } });
    fireEvent.click(add(p));
    await settle();
    expect(posts).toEqual([]);
    expect(box(p).getAttribute("aria-invalid")).toBe("true");
    expect(box(p).closest(".ui-field")!.querySelector(".ui-error")).not.toBeNull();
    expect(location.pathname).toBe("/facts/new");
  });

  it("opens the new fact in place of the form, filters kept, and draws it first in the list", async () => {
    const p = await openForm();
    const depth = history.length;
    fireEvent.change(box(p), { target: { value: "run the migrations first" } });
    fireEvent.click(add(p));
    await waitFor(() => expect(location.pathname).toBe("/facts/n1"));
    expect(location.search).toBe("?kind=gotcha");
    expect(history.length).toBe(depth);
    const pane = await screen.findByRole("complementary", { name: "Selected fact" });
    await within(pane).findByText("run the migrations first", { selector: ".bigfact" });
    // The list is filtered to Pitfall, and the new fact is a Decision: it shows anyway, first.
    await waitFor(() => expect(listTexts()).toEqual(["n1", "f1"]));
    expect(within(header()).getByRole("button", { name: "Add a fact" })).toBeTruthy();
    expect(within(pane).queryByRole("status")).toBeNull();
  });

  it("keeps a member's team fact, a candidate, in the list under Live", async () => {
    me = { role: "member", user_id: "u9" };
    const p = await openForm();
    fireEvent.change(box(p), { target: { value: "billing deploys on tuesdays" } });
    fireEvent.click(within(p).getByRole("radio", { name: "Team: Billing" }));
    fireEvent.click(add(p));
    const pane = await screen.findByRole("complementary", { name: "Selected fact" });
    await within(pane).findByText("Waiting for review");
    await waitFor(() => expect(listTexts()).toEqual(["n1", "f1"]));
    expect(within(list()).getByText(/Waiting for review/)).toBeTruthy();
  });

  it("drops the added fact from the list once the filters change", async () => {
    const p = await openForm();
    fireEvent.change(box(p), { target: { value: "run the migrations first" } });
    fireEvent.click(add(p));
    await waitFor(() => expect(listTexts()).toEqual(["n1", "f1"]));
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "invariant" } });
    await waitFor(() => expect(screen.getByText("Nothing matches these filters")).toBeTruthy());
    expect(listTexts()).toEqual([]);
  });

  it("says when the fact was already there, and opens that one", async () => {
    const p = await openForm();
    fireEvent.change(box(p), { target: { value: "a live fact" } });
    fireEvent.click(add(p));
    await waitFor(() => expect(location.pathname).toBe("/facts/f1"));
    const pane = await screen.findByRole("complementary", { name: "Selected fact" });
    expect(within(pane).getByRole("status").textContent).toBe("That's already a fact.");
    fireEvent.click(within(pane).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(location.pathname).toBe("/facts"));
    // Back to the same fact without opening it from the list: the notice was for the add, and is gone.
    history.back();
    await waitFor(() => expect(location.pathname).toBe("/facts/f1"));
    const back = await screen.findByRole("complementary", { name: "Selected fact" });
    await within(back).findByText("a live fact", { selector: ".bigfact" });
    expect(within(back).queryByRole("status")).toBeNull();
    fireEvent.click(within(back).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(location.pathname).toBe("/facts"));
    fireEvent.click(within(list()).getByText("a live fact"));
    const again = await screen.findByRole("complementary", { name: "Selected fact" });
    await within(again).findByText("a live fact", { selector: ".bigfact" });
    expect(within(again).queryByRole("status")).toBeNull();
  });

  it("tells a member a shared fact waits for review, and not a Just me one; a curator never", async () => {
    me = { role: "member", user_id: "u9" };
    let p = await openForm();
    const review = "A curator reviews it before agents get it.";
    expect(within(p).queryByText(review)).toBeNull();
    fireEvent.click(within(p).getByRole("radio", { name: "Everyone" }));
    expect(within(p).getByText(review)).toBeTruthy();
    fireEvent.click(within(p).getByRole("radio", { name: "Just me" }));
    expect(within(p).queryByText(review)).toBeNull();
    cleanup();
    me = { role: "curator", user_id: "c1" };
    p = await openForm();
    fireEvent.click(within(p).getByRole("radio", { name: "Everyone" }));
    expect(within(p).queryByText(review)).toBeNull();
  });

  it("offers a member only their own teams, and a curator every team", async () => {
    const teamRadios = (p: HTMLElement) =>
      within(p)
        .getAllByRole("radio")
        .map((r) => r.closest(".who-option")!.querySelector("label")!.textContent)
        .filter((l) => l!.startsWith("Team:"));
    me = { role: "member", user_id: "u9" };
    let p = await openForm();
    expect(teamRadios(p)).toEqual(["Team: Billing"]);
    cleanup();
    me = { role: "curator", user_id: "c1" };
    p = await openForm();
    expect(teamRadios(p)).toEqual(["Team: Billing", "Team: Ops"]);
    const labels = [...p.querySelectorAll(".who-option label")].map((l) => l.textContent);
    expect(labels).toEqual(["Just me", "A repo…", "Team: Billing", "Team: Ops", "Everyone"]);
  });

  it("a refused add shows the hive's error under the box and keeps everything typed", async () => {
    fail = { status: 403, body: { error: "not a member of team ops" } };
    const p = await openForm();
    fireEvent.change(box(p), { target: { value: "ops pages at night" } });
    fireEvent.change(within(p).getByRole("combobox", { name: "Kind" }), { target: { value: "convention" } });
    fireEvent.click(within(p).getByRole("radio", { name: "Team: Ops" }));
    fireEvent.click(add(p));
    const err = await within(p).findByText("not a member of team ops");
    expect(err.closest(".ui-field")).toBe(box(p).closest(".ui-field"));
    expect(box(p).value).toBe("ops pages at night");
    expect((within(p).getByRole("combobox", { name: "Kind" }) as HTMLSelectElement).value).toBe("convention");
    expect(within(p).getByRole("radio", { name: "Team: Ops" })).toHaveProperty("checked", true);
    expect(location.pathname).toBe("/facts/new");
    expect(add(p).disabled).toBe(false);
  });

  it("Cancel and Esc close the form back to the list, filters kept, and send nothing", async () => {
    let p = await openForm();
    fireEvent.click(within(p).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(location.pathname).toBe("/facts"));
    expect(location.search).toBe("?kind=gotcha");
    expect(screen.queryByRole("complementary", { name: "Add a fact" })).toBeNull();
    fireEvent.click(within(header()).getByRole("button", { name: "Add a fact" }));
    p = await form();
    fireEvent.keyDown(box(p), { key: "Escape" });
    await waitFor(() => expect(location.pathname).toBe("/facts"));
    expect(posts).toEqual([]);
  });

  it("has exactly one primary button: on the list, in the form, with a fact open, and while editing it", async () => {
    history.replaceState(null, "", "/facts");
    render(<Facts />);
    await waitFor(() => expect(listTexts()).toEqual(["f1"]));
    expect(primaries()).toBe(1);
    fireEvent.click(within(header()).getByRole("button", { name: "Add a fact" }));
    const p = await form();
    expect(primaries()).toBe(1);
    expect(p.querySelector(".btn.primary")!.textContent).toBe("Add this fact");

    fireEvent.click(within(p).getByRole("button", { name: "Cancel" }));
    fireEvent.click(await within(list()).findByText("a live fact"));
    const pane = await screen.findByRole("complementary", { name: "Selected fact" });
    const edit = await within(pane).findByRole("button", { name: "Edit…" });
    expect(primaries()).toBe(1);
    expect(header().querySelector(".btn.primary")!.textContent).toBe("Add a fact");
    fireEvent.click(edit);
    await waitFor(() => expect(within(header()).queryByRole("button", { name: "Add a fact" })).toBeNull());
    expect(primaries()).toBe(1);
    expect(pane.querySelector(".btn.primary")!.textContent).toBe("Save the new wording");

    fireEvent.click(within(pane).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(within(header()).getByRole("button", { name: "Add a fact" })).toBeTruthy());
    expect(primaries()).toBe(1);
  });

  it("brings Add a fact back when the fact closes with a form still open", async () => {
    history.replaceState(null, "", "/facts/f1");
    render(<Facts />);
    const pane = await screen.findByRole("complementary", { name: "Selected fact" });
    fireEvent.click(await within(pane).findByRole("button", { name: "Edit…" }));
    await waitFor(() => expect(within(header()).queryByRole("button", { name: "Add a fact" })).toBeNull());
    fireEvent.click(within(pane).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(location.pathname).toBe("/facts"));
    expect(within(header()).getByRole("button", { name: "Add a fact" })).toBeTruthy();
  });
});
