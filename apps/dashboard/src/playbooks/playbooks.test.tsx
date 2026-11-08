import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { Playbook } from "./api";

const FACT_ID = "11111111-1111-4111-8111-111111111111";

function playbook(id: string, over: Partial<Playbook> = {}): Playbook {
  return {
    id,
    scope: "global",
    title: `playbook ${id}`,
    applies_paths: [],
    applies_words: [],
    steps: [],
    pitfalls: [],
    status: "active",
    supersedes: null,
    author_user_id: "u1",
    created_at: "2026-11-01T12:00:00Z",
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let role: "curator" | "member";
let stored: Record<string, Playbook>;
let postAnswer: (body: unknown) => Response;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://hive");
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url.pathname === "/v1/status") return json({ version: "t", instance: { id: "i1", name: "laptop", user_id: "u1", role } });
  if (url.pathname === "/v1/repos") return json({ repos: [{ key: "acme/widgets" }] });
  if (url.pathname === "/v1/facts") return json({ facts: [], has_more: false });
  if (url.pathname.startsWith("/v1/facts/")) {
    const id = url.pathname.slice("/v1/facts/".length);
    return json({ fact: { id, text: `the text of ${id}` }, anchors: [], reviews: [], supersedes: [], superseded_by: [] });
  }
  if (url.pathname === "/v1/playbooks" && method === "GET") return json({ playbooks: Object.values(stored) });
  if (url.pathname === "/v1/playbooks" && method === "POST") return postAnswer(body);
  const id = url.pathname.slice("/v1/playbooks/".length);
  if (method === "GET") return stored[id] ? json({ playbook: stored[id] }) : json({ error: "no such playbook" }, 404);
  if (method === "PUT") return json({ playbook: (stored.p2 = { ...stored[id]!, ...body, id: "p2", supersedes: id }) });
  if (method === "DELETE") return json({ playbook: { ...stored[id]!, status: "retracted" } });
  return json({ error: "not found" }, 404);
});

function callsTo(method: string, path: string) {
  return fetchMock.mock.calls.filter(([u, init]) => String(u) === path && (init?.method ?? "GET") === method);
}

function bodyOf(method: string, path: string) {
  const calls = callsTo(method, path);
  expect(calls).toHaveLength(1);
  return JSON.parse(String(calls[0]![1]!.body));
}

function open(path: string) {
  history.replaceState(null, "", path);
  render(<App />);
}

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  sessionStorage.setItem("hive.token", "t");
  role = "curator";
  stored = {};
  postAnswer = (body) => json({ playbook: (stored.p1 = { ...playbook("p1"), ...(body as object) }) }, 201);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("playbooks", () => {
  it("lists active playbooks grouped by scope, global first, with a scope filter", async () => {
    stored = {
      a: playbook("a", { scope: "repo:acme/widgets", title: "Repo one", applies_words: ["migration"] }),
      b: playbook("b", { title: "Global one", applies_paths: ["src/**"] }),
    };
    open("/playbooks");
    await screen.findByText("Global one");
    const sections = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(sections).toEqual(["global", "repo:acme/widgets"]);
    expect(within(screen.getByRole("region", { name: "global" })).getByText("src/**")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "Scope" })).getByRole("button", { name: "repo:acme/widgets" }));
    expect(screen.queryByText("Global one")).toBeNull();
    expect(screen.getByText("migration")).toBeTruthy();
  });

  it("create sends the right POST body and opens the new playbook", async () => {
    open("/playbooks/new");
    await screen.findByLabelText("Title");
    type("Title", "Add a migration");
    type("Scope", "repo");
    await waitFor(() => expect(document.querySelector('#pb-repos option[value="acme/widgets"]')).not.toBeNull());
    type("Repo", "acme/widgets");
    type("Path globs", "apps/hive/migrations/**\nsrc/db.ts");
    type("Task words", "migration, schema");
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    type("Step 1", "Write the SQL file");
    type("Step 1 fact ids", FACT_ID);
    fireEvent.click(screen.getByRole("button", { name: "Add pitfall" }));
    type("Pitfall 1", "Never edit an applied migration");
    fireEvent.click(screen.getByRole("button", { name: "Create playbook" }));

    await screen.findByRole("heading", { name: "Add a migration" });
    expect(bodyOf("POST", "/v1/playbooks")).toEqual({
      scope: "repo:acme/widgets",
      title: "Add a migration",
      applies_paths: ["apps/hive/migrations/**", "src/db.ts"],
      applies_words: ["migration", "schema"],
      steps: [{ text: "Write the SQL file", fact_ids: [FACT_ID] }],
      pitfalls: [{ text: "Never edit an applied migration", fact_ids: [] }],
    });
    expect(location.pathname).toBe("/playbooks/p1");
  });

  it("move up/down and remove change the order in the body", async () => {
    open("/playbooks/new");
    await screen.findByLabelText("Title");
    type("Title", "Order");
    for (const t of ["one", "two", "three"]) {
      fireEvent.click(screen.getByRole("button", { name: "Add step" }));
      type(`Step ${screen.getAllByLabelText(/^Step \d+$/).length}`, t);
    }
    fireEvent.click(screen.getByRole("button", { name: "Move step 3 up" })); // one three two
    fireEvent.click(screen.getByRole("button", { name: "Move step 1 down" })); // three one two
    fireEvent.click(screen.getByRole("button", { name: "Remove step 2" })); // three two
    fireEvent.click(screen.getByRole("button", { name: "Create playbook" }));
    await waitFor(() => expect(callsTo("POST", "/v1/playbooks")).toHaveLength(1));
    expect(bodyOf("POST", "/v1/playbooks").steps.map((s: { text: string }) => s.text)).toEqual(["three", "two"]);
  });

  it("shows the hive's 400 message inline", async () => {
    postAnswer = () => json({ error: `unknown fact ids: ${FACT_ID}` }, 400);
    open("/playbooks/new");
    await screen.findByLabelText("Title");
    type("Title", "Bad");
    fireEvent.click(screen.getByRole("button", { name: "Create playbook" }));
    expect((await screen.findByRole("alert")).textContent).toBe(`unknown fact ids: ${FACT_ID}`);
    expect(location.pathname).toBe("/playbooks/new");
  });

  it("edit sends PUT and shows 'version of' the old one", async () => {
    stored = { p1: playbook("p1", { title: "Old title", applies_words: ["deploy"], steps: [{ text: "s", fact_ids: [] }] }) };
    open("/playbooks/p1");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(location.pathname).toBe("/playbooks/p1/edit");
    const title = (await screen.findByLabelText("Title")) as HTMLInputElement;
    expect(title.value).toBe("Old title");
    type("Title", "New title");
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));

    await screen.findByRole("heading", { name: "New title" });
    expect(bodyOf("PUT", "/v1/playbooks/p1")).toEqual({
      scope: "global",
      title: "New title",
      applies_paths: [],
      applies_words: ["deploy"],
      steps: [{ text: "s", fact_ids: [] }],
      pitfalls: [],
    });
    expect(location.pathname).toBe("/playbooks/p2");
    expect(screen.getByText(/Version of/).textContent).toContain("p1");
    expect(screen.getByRole("link", { name: "p1" }).getAttribute("href")).toBe("/playbooks/p1");
  });

  it("linked fact text links to /facts/<id>, fetched once per id", async () => {
    stored = {
      p1: playbook("p1", {
        steps: [{ text: "first", fact_ids: [FACT_ID] }],
        pitfalls: [{ text: "careful", fact_ids: [FACT_ID] }],
      }),
    };
    open("/playbooks/p1");
    const links = await screen.findAllByRole("link", { name: `the text of ${FACT_ID}` });
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("href")).toBe(`/facts/${FACT_ID}`);
    expect(callsTo("GET", `/v1/facts/${FACT_ID}`)).toHaveLength(1);
    fireEvent.click(links[0]!);
    expect(location.pathname).toBe(`/facts/${FACT_ID}`);
  });

  it("retract confirms, sends DELETE and goes back to the list", async () => {
    stored = { p1: playbook("p1", { title: "Doomed" }) };
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    open("/playbooks/p1");
    fireEvent.click(await screen.findByRole("button", { name: "Retract" }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(callsTo("DELETE", "/v1/playbooks/p1")).toHaveLength(0);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Retract" }));
    await waitFor(() => expect(location.pathname).toBe("/playbooks"));
    expect(callsTo("DELETE", "/v1/playbooks/p1")).toHaveLength(1);
  });

  it("shows 'No playbooks yet.' when the list is empty", async () => {
    open("/playbooks");
    expect(await screen.findByText("No playbooks yet.")).toBeTruthy();
  });

  it("hides Edit and Retract once a playbook is no longer active", async () => {
    stored = { p1: playbook("p1", { title: "Gone", status: "retracted" }) };
    open("/playbooks/p1");
    await screen.findByRole("heading", { name: "Gone" });
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retract" })).toBeNull();
  });

  it("a member sees no tab and a curators-only note", async () => {
    role = "member";
    open("/playbooks");
    expect((await screen.findByRole("note")).textContent).toContain("curators only");
    expect(screen.queryByRole("link", { name: "Playbooks" })).toBeNull();
    expect(callsTo("GET", "/v1/playbooks")).toHaveLength(0);
  });
});
