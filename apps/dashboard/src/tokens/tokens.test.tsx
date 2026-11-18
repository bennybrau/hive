import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tokens, type Instance } from "./Tokens";

const AGO = new Date(Date.now() - 3 * 3600_000).toISOString();

function inst(id: string, over: Partial<Instance> = {}): Instance {
  return { id, name: `${id}-laptop`, user_id: id, role: "member", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, revoked_at: null, rotated_at: null, ...over };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let instances: Instance[];
/** Replies to anything but the list GET. */
let change: (url: URL, init: RequestInit) => Response;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = new URL(String(input), "http://hive");
  const method = init.method ?? "GET";
  if (method === "GET" && url.pathname === "/v1/instances") {
    return json({ instances: url.searchParams.get("revoked") === "true" ? instances : instances.filter((i) => !i.revoked_at) });
  }
  return change(url, init);
});

/** The non-GET calls so far, as [method, raw path, body]. */
function changes(): [string, string, unknown][] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method && init.method !== "GET")
    .map(([u, init]) => [init!.method!, String(u), init!.body ? JSON.parse(String(init!.body)) : undefined]);
}

const row = (id: string) => document.querySelector(`tr[data-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  instances = [
    inst("me", { name: "my-laptop", user_id: "cora", role: "curator", last_seen_at: AGO }),
    inst("ana", { rotated_at: AGO }),
    inst("w1", { name: "worker-a", user_id: "hive", role: "worker" }),
    inst("old", { revoked_at: AGO }),
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
  render(<Tokens role="curator" selfId="me" />);
  await screen.findByText("ana-laptop");
}

describe("tokens page", () => {
  it("is for curators only", () => {
    render(<Tokens role="member" selfId="me" />);
    expect(screen.getByRole("note").textContent).toBe("Only a Curator can manage tokens.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists tokens with role words, last seen and 'Never', and rotated", async () => {
    await open();
    expect(within(row("me")).getByText("Curator")).toBeTruthy();
    expect(within(row("me")).getByText("3 hours ago").tagName).toBe("TIME");
    expect(within(row("ana")).getByText("Member")).toBeTruthy();
    expect(row("ana").textContent).toContain("Never");
    expect(row("ana").textContent).toContain("rotated 3 hours ago");
    expect(within(row("w1")).getByText("Worker")).toBeTruthy();
    expect(row("w1").textContent).not.toContain("rotated");
    expect(row("old")).toBeNull();
  });

  it("marks your own row and gives it no Revoke", async () => {
    await open();
    expect(within(row("me")).getByText("you")).toBeTruthy();
    expect(within(row("me")).queryByRole("button", { name: /Revoke/ })).toBeNull();
    expect(within(row("me")).getByRole("button", { name: "Rotate my-laptop" })).toBeTruthy();
    expect(within(row("me")).getByText("you'll be signed out")).toBeTruthy();
    expect(within(row("ana")).queryByText("you")).toBeNull();
  });

  it("revoke asks inline first, Cancel backs out, Yes posts and drops the row", async () => {
    change = (url) => json({ instance: { ...instances.find((i) => url.pathname.includes(i.id))!, revoked_at: new Date().toISOString() } });
    await open();
    fireEvent.click(within(row("ana")).getByRole("button", { name: "Revoke ana-laptop" }));
    expect(row("ana").textContent).toContain("Revoke ana-laptop?");
    fireEvent.click(within(row("ana")).getByRole("button", { name: "Cancel" }));
    expect(within(row("ana")).getByRole("button", { name: "Revoke ana-laptop" })).toBeTruthy();
    expect(changes()).toEqual([]);

    fireEvent.click(within(row("ana")).getByRole("button", { name: "Revoke ana-laptop" }));
    fireEvent.click(within(row("ana")).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(row("ana")).toBeNull());
    expect(changes()).toEqual([["POST", "/v1/instances/ana/revoke", undefined]]);
  });

  it("rotate shows the new token once, and Dismiss removes it", async () => {
    change = (url) => json({ instance: { ...instances.find((i) => url.pathname.includes(i.id))!, rotated_at: new Date().toISOString() }, token: "hv_secret123" });
    await open();
    fireEvent.click(within(row("w1")).getByRole("button", { name: "Rotate worker-a" }));
    expect(row("w1").textContent).toContain("Rotate worker-a?");
    fireEvent.click(within(row("w1")).getByRole("button", { name: "Yes" }));
    const box = await screen.findByLabelText("Token for worker-a");
    expect((box as HTMLInputElement).value).toBe("hv_secret123");
    expect((box as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText("You won't see this again.")).toBeTruthy();
    expect(row("w1").textContent).toContain("rotated just now");
    expect(changes()).toEqual([["POST", "/v1/instances/w1/rotate", undefined]]);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByLabelText("Token for worker-a")).toBeNull();
    expect(screen.queryByDisplayValue("hv_secret123")).toBeNull();
  });

  it("Copy puts the new token on the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    change = (url) => json({ instance: instances.find((i) => url.pathname.includes(i.id))!, token: "hv_copyme" });
    await open();
    fireEvent.click(within(row("w1")).getByRole("button", { name: "Rotate worker-a" }));
    fireEvent.click(within(row("w1")).getByRole("button", { name: "Yes" }));
    await screen.findByLabelText("Token for worker-a");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("hv_copyme");
    await screen.findByRole("button", { name: "Copied" });
  });

  it("Show revoked refetches with revoked=true and dims revoked rows without buttons", async () => {
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show revoked" }));
    await waitFor(() => expect(row("old")).toBeTruthy());
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("/v1/instances?revoked=true");
    expect(row("old").className).toBe("revoked");
    expect(within(row("old")).queryAllByRole("button")).toEqual([]);
    expect(row("ana").className).toBe("");
  });

  it("creates a token and shows it once, and shows a 409 inline", async () => {
    change = (_url, init) => {
      const body = JSON.parse(String(init.body)) as { name: string; user_id: string; role: Instance["role"] };
      return body.name === "ana-laptop"
        ? json({ error: "an instance named ana-laptop already exists" }, 409)
        : json({ instance: inst("new", { ...body }), token: "hv_new456" }, 201);
    };
    await open();
    const form = screen.getByRole("form", { name: "New token" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "ana-laptop" } });
    fireEvent.change(within(form).getByLabelText("Person"), { target: { value: "ana" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create token" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("an instance named ana-laptop already exists");

    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "bo-laptop" } });
    fireEvent.change(within(form).getByLabelText("Person"), { target: { value: "bo" } });
    fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "curator" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create token" }));
    expect(((await screen.findByLabelText("Token for bo-laptop")) as HTMLInputElement).value).toBe("hv_new456");
    expect(within(row("new")).getByText("Curator")).toBeTruthy();
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(changes().at(-1)).toEqual(["POST", "/v1/instances", { name: "bo-laptop", user_id: "bo", role: "curator" }]);
  });
});
