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

// A small hive: the facts, who is signed in, and what the next save answers.
let facts: Map<string, Fact>;
let replaces: Map<string, string>;
let me: { role: string; user_id: string } | null;
let fail: { status: number; body: unknown } | null;
let mergeInto: string | null;
const posts: { path: string; body: unknown }[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  const path = url.pathname;
  if (path === "/v1/status") {
    return me ? json({ version: "1", instance: { id: "i1", name: "me", ...me } }) : json({ error: "nope" }, 500);
  }
  if (path === "/v1/repos") return json({ repos: [{ key: "acme/widgets" }] });
  if (path === "/v1/repo-keys") return json({ repo_keys: ["acme/widgets", "acme/other"] });
  if (path === "/v1/teams" || path === "/v1/teams/mine") return json({ teams: [] });
  if (path === "/v1/facts") return json({ facts: [...facts.values()].filter((f) => f.status === "active"), has_more: false, total: 0 });

  const m = /^\/v1\/facts\/([^/]+)(?:\/(curate|retract))?$/.exec(path);
  if (!m) return json({ error: "not found" }, 404);
  const [, id, verb] = m as unknown as [string, string, string | undefined];
  const f = facts.get(id);
  if (!f) return json({ error: "no such fact" }, 404);

  if (!verb) {
    const old = [...replaces].filter(([, by]) => by === id).map(([o]) => facts.get(o)!);
    return json({
      fact: f,
      anchors: [{ id: "a1", episode_id: null, repo_key: "acme/widgets", commit_sha: null, path: "src/a.ts", line_start: 1, line_end: 1, quote: null, verify_status: "verified", verified_at: null, verify_note: null, found_line: 1, remote_url: null }],
      reviews: [],
      supersedes: old.map((o) => ({ id: o.id, text: o.text, status: o.status, recorded_at: o.recorded_at })),
      superseded_by: [],
    });
  }

  const body = JSON.parse(String(init?.body)) as Record<string, string>;
  posts.push({ path, body });
  if (fail) return json(fail.body, fail.status);
  if (verb === "retract") {
    facts.set(id, { ...f, status: "retracted", status_note: body.reason! });
    return json({ fact: facts.get(id) });
  }
  if (body.action === "fix") {
    const next = fact(`${id}-v2`, { ...f, id: `${id}-v2`, text: body.new_text! });
    facts.set(id, { ...f, status: "superseded" });
    facts.set(next.id, next);
    replaces.set(id, next.id);
    return json({ fact: facts.get(id), new_fact: next });
  }
  if (body.action === "move") {
    if (mergeInto) {
      facts.set(id, { ...f, status: "retracted", status_note: "merged" });
      return json({ fact: facts.get(id), new_fact: null, merged_into: facts.get(mergeInto) });
    }
    facts.set(id, { ...f, scope: body.scope! });
    return json({ fact: facts.get(id), new_fact: null, merged_into: null });
  }
  if (body.action === "retire") {
    facts.set(id, { ...f, status: "retracted", status_note: `retired: ${body.note}` });
    return json({ fact: facts.get(id), new_fact: null });
  }
  return json({ error: "bad action" }, 400);
});

const listCalls = () => fetchMock.mock.calls.filter(([u]) => new URL(String(u), "http://hive").pathname === "/v1/facts").length;
const pane = () => screen.findByRole("complementary", { name: "Selected fact" });
const primaries = (p: HTMLElement) => p.querySelectorAll(".btn.primary").length;
const button = (p: HTMLElement, name: string) => within(p).getByRole("button", { name }) as HTMLButtonElement;
const actionNames = (p: HTMLElement) => [...p.querySelectorAll(".pane-actions button")].map((b) => b.textContent);

/** Opens /facts/<id> with a filter in the URL and waits for the fact and its actions (if any) to show. */
async function openFact(id: string) {
  history.replaceState(null, "", `/facts/${id}?kind=gotcha`);
  render(<Facts />);
  const p = await pane();
  await within(p).findByText(facts.get(id)!.text, { selector: ".bigfact" });
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === "/v1/status")).toBe(true));
  // Let the status answer land, so a missing button means "not for you" rather than "not loaded yet".
  await act(() => new Promise((r) => setTimeout(r, 20)));
  return p;
}

beforeEach(() => {
  facts = new Map([
    ["f1", fact("f1", { text: "the open fact" })],
    ["f2", fact("f2", { text: "the other fact" })],
    ["mine", fact("mine", { text: "my own fact", scope: "personal:u9", author_user_id: "u9" })],
    ["old", fact("old", { text: "a retired fact", status: "retracted", status_note: "wrong" })],
  ]);
  replaces = new Map();
  me = { role: "curator", user_id: "c1" };
  fail = null;
  mergeInto = null;
  posts.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the open fact's actions", () => {
  it("a curator gets Edit…, Change who gets it… and Retire, and no primary button until a form is open", async () => {
    const p = await openFact("f1");
    await waitFor(() => expect(actionNames(p)).toEqual(["Edit…", "Change who gets it…", "Retire"]));
    expect(button(p, "Retire").className).toBe("btn quiet");
    expect(button(p, "Edit…").className).toBe("btn");
    // Under the three plain lines, above the Replaces chain.
    expect(p.querySelector("dl.kv + .pane-actions")).not.toBeNull();
    expect(primaries(p)).toBe(0);
  });

  it("Edit… saves the trimmed wording, opens the new fact in place of the old one with the filters kept, and the list re-fetches", async () => {
    const p = await openFact("f1");
    fireEvent.click(await within(p).findByRole("button", { name: "Edit…" }));
    const box = within(p).getByRole("textbox", { name: "Edit the fact" }) as HTMLTextAreaElement;
    expect(box.value).toBe("the open fact");
    expect(actionNames(p)).toEqual(["Save the new wording", "Cancel"]);
    expect(primaries(p)).toBe(1);

    fireEvent.change(box, { target: { value: "  ab " } });
    expect(button(p, "Save the new wording").disabled).toBe(true);
    fireEvent.change(box, { target: { value: "  the better fact  " } });
    expect(button(p, "Save the new wording").disabled).toBe(false);

    const before = listCalls();
    const depth = history.length;
    fireEvent.click(button(p, "Save the new wording"));
    await waitFor(() => expect(location.pathname).toBe("/facts/f1-v2"));
    expect(posts).toEqual([{ path: "/v1/facts/f1/curate", body: { action: "fix", new_text: "the better fact" } }]);
    expect(location.search).toBe("?kind=gotcha");
    expect(history.length).toBe(depth);

    const next = await pane();
    await within(next).findByText("the better fact", { selector: ".bigfact" });
    const chain = next.querySelector(".chain")!;
    expect(chain.querySelector("h3")!.textContent).toBe("Replaces");
    expect(within(chain as HTMLElement).getByRole("link", { name: "the open fact" })).toBeTruthy();
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    const list = document.querySelector(".kn-list") as HTMLElement;
    await within(list).findByText("the better fact");
    expect(within(list).queryByText("the open fact")).toBeNull();
  });

  it("Change who gets it… offers the anchor's repo, sends the move, then reloads the fact at its new level", async () => {
    const p = await openFact("f1");
    fireEvent.click(await within(p).findByRole("button", { name: "Change who gets it…" }));
    expect(within(p).getByRole("radio", { name: "Everyone (current)" })).toHaveProperty("checked", true);
    const move = () => p.querySelector<HTMLButtonElement>(".btn.primary")!;
    expect(move().textContent).toBe("Move to Everyone");
    expect(move().disabled).toBe(true);
    expect(primaries(p)).toBe(1);

    fireEvent.click(within(p).getByRole("radio", { name: "Repo: widgets" }));
    expect(move().textContent).toBe("Move to Repo: widgets");
    expect(move().disabled).toBe(false);

    const before = listCalls();
    fireEvent.click(move());
    await waitFor(() => expect(p.querySelector(".ui-badge.who")?.textContent).toBe("Repo: widgets"));
    expect(posts).toEqual([{ path: "/v1/facts/f1/curate", body: { action: "move", scope: "repo:acme/widgets" } }]);
    expect(location.pathname).toBe("/facts/f1");
    expect(within(p).getByText("Agents working in the widgets repo.")).toBeTruthy();
    expect(actionNames(p)).toEqual(["Edit…", "Change who gets it…", "Retire"]);
    expect(listCalls()).toBeGreaterThan(before);
  });

  it("a move that merged into another fact opens that fact", async () => {
    mergeInto = "f2";
    const p = await openFact("f1");
    fireEvent.click(await within(p).findByRole("button", { name: "Change who gets it…" }));
    fireEvent.click(within(p).getByRole("radio", { name: "Repo: widgets" }));
    fireEvent.click(button(p, "Move to Repo: widgets"));
    await waitFor(() => expect(location.pathname).toBe("/facts/f2"));
    expect(location.search).toBe("?kind=gotcha");
    await within(await pane()).findByText("the other fact", { selector: ".bigfact" });
  });

  it("a curator's Retire needs a reason, sends it with the retire, and the pane shows Retired with it", async () => {
    const p = await openFact("f1");
    fireEvent.click(await within(p).findByRole("button", { name: "Retire" }));
    const box = within(p).getByRole("textbox", { name: "Why? This is kept with the fact." });
    expect(actionNames(p)).toEqual(["Retire this fact", "Cancel"]);
    expect(primaries(p)).toBe(1);

    fireEvent.change(box, { target: { value: "no" } });
    fireEvent.click(button(p, "Retire this fact"));
    expect(posts).toEqual([]);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.closest(".ui-field")!.querySelector(".ui-error")).not.toBeNull();

    const before = listCalls();
    fireEvent.change(box, { target: { value: " it is wrong " } });
    fireEvent.click(button(p, "Retire this fact"));
    await waitFor(() => expect(within(p).getAllByText("Retired").length).toBeGreaterThan(0));
    expect(posts).toEqual([{ path: "/v1/facts/f1/curate", body: { action: "retire", note: "it is wrong" } }]);
    const kv = p.querySelector("dl.kv")!;
    const dt = [...kv.querySelectorAll("dt")].find((d) => d.textContent === "Retired")!;
    expect(dt.nextElementSibling!.textContent).toBe("retired: it is wrong");
    expect(p.querySelector(".pane-actions, .pane-edit")).toBeNull();
    expect(listCalls()).toBeGreaterThan(before);
  });

  it("a member gets only Retire on their own Just me fact, and it retracts with the reason", async () => {
    me = { role: "member", user_id: "u9" };
    const p = await openFact("mine");
    await waitFor(() => expect(actionNames(p)).toEqual(["Retire"]));
    fireEvent.click(button(p, "Retire"));
    fireEvent.change(within(p).getByRole("textbox", { name: "Why? This is kept with the fact." }), { target: { value: "not true now" } });
    fireEvent.click(button(p, "Retire this fact"));
    await waitFor(() => expect(posts).toEqual([{ path: "/v1/facts/mine/retract", body: { reason: "not true now" } }]));
    await waitFor(() => expect(p.querySelector(".pane-actions")).toBeNull());
    const dt = [...p.querySelectorAll("dl.kv dt")].find((d) => d.textContent === "Retired")!;
    expect(dt.nextElementSibling!.textContent).toBe("not true now");
  });

  it("a member gets nothing on a shared fact, nor on someone else's Just me fact", async () => {
    me = { role: "member", user_id: "u1" };
    let p = await openFact("f1");
    expect(p.querySelector(".pane-actions")).toBeNull();
    cleanup();
    me = { role: "member", user_id: "u8" };
    facts.set("theirs", fact("theirs", { scope: "personal:u9", author_user_id: "u9" }));
    p = await openFact("theirs");
    expect(p.querySelector(".pane-actions")).toBeNull();
    // Just me for them, but written by someone else (a curator's move): not theirs to retract.
    cleanup();
    me = { role: "member", user_id: "u9" };
    facts.set("moved", fact("moved", { scope: "personal:u9", author_user_id: "u1" }));
    p = await openFact("moved");
    expect(p.querySelector(".pane-actions")).toBeNull();
  });

  it("nobody gets actions on a fact that isn't live, or before the hive says who they are", async () => {
    let p = await openFact("old");
    expect(within(p).getAllByText("Retired").length).toBeGreaterThan(0);
    expect(p.querySelector(".pane-actions")).toBeNull();
    cleanup();
    me = null;
    p = await openFact("f1");
    expect(p.querySelector(".pane-actions")).toBeNull();
  });

  it("a failed save shows the hive's error under the box and keeps what was typed", async () => {
    fail = { status: 409, body: { error: "a fact with that wording already exists" } };
    const p = await openFact("f1");
    fireEvent.click(await within(p).findByRole("button", { name: "Edit…" }));
    const box = within(p).getByRole("textbox", { name: "Edit the fact" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "the same fact" } });
    fireEvent.click(button(p, "Save the new wording"));
    const err = await within(p).findByText("a fact with that wording already exists");
    expect(err.className).toBe("ui-error");
    expect(err.closest(".ui-field")).toBe(box.closest(".ui-field"));
    expect(box.value).toBe("the same fact");
    expect(location.pathname).toBe("/facts/f1");
    expect(button(p, "Save the new wording").disabled).toBe(false);
  });

  it("a failed save with no error in the body says what the hive answered", async () => {
    fail = { status: 500, body: "oops" };
    const p = await openFact("f1");
    fireEvent.click(await within(p).findByRole("button", { name: "Retire" }));
    const box = within(p).getByRole("textbox", { name: "Why? This is kept with the fact." }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "duplicate" } });
    fireEvent.click(button(p, "Retire this fact"));
    await within(p).findByText("The hive answered 500.");
    expect(box.value).toBe("duplicate");
  });

  it("Esc cancels the form and leaves the pane open; the next Esc closes it", async () => {
    const p = await openFact("f1");
    fireEvent.click(await within(p).findByRole("button", { name: "Edit…" }));
    const box = within(p).getByRole("textbox", { name: "Edit the fact" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(within(p).queryByRole("textbox")).toBeNull();
    expect(actionNames(p)).toEqual(["Edit…", "Change who gets it…", "Retire"]);
    expect(location.pathname).toBe("/facts/f1");
    expect(screen.getByRole("complementary", { name: "Selected fact" })).toBe(p);

    fireEvent.click(button(p, "Change who gets it…"));
    fireEvent.keyDown(within(p).getByRole("radio", { name: "Everyone (current)" }), { key: "Escape" });
    expect(p.querySelector(".who-gets-this")).toBeNull();
    expect(location.pathname).toBe("/facts/f1");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(location.pathname).toBe("/facts");
  });

  it("Cancel closes the form without saving", async () => {
    const p = await openFact("f1");
    fireEvent.click(await within(p).findByRole("button", { name: "Retire" }));
    fireEvent.click(button(p, "Cancel"));
    expect(actionNames(p)).toEqual(["Edit…", "Change who gets it…", "Retire"]);
    expect(posts).toEqual([]);
  });
});
