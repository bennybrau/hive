import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { apiFetch } from "./api";

const STATUS = {
  ok: true,
  version: "test",
  instance: { id: "i1", name: "bennys-laptop", user_id: "u1", role: "member" },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** What Home shows for an empty hive. */
const HOME = { facts: { live: 0, by_level: [] }, recent: [], repos: { count: 0, last_read_at: null, problems: 0 }, teams: { count: 0 } };

/** A fake hive that accepts only `good-token`. */
const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== "Bearer good-token") return json(401, { error: "unauthorized" });
  return String(url) === "/v1/home" ? json(200, HOME) : json(200, STATUS);
});

/** A curator's hive: status and Home as usual, `body` for every other call. */
const asCurator = (body: unknown) => async (url: RequestInfo | URL) =>
  String(url) === "/v1/status"
    ? json(200, { ...STATUS, instance: { ...STATUS.instance, role: "curator" } })
    : String(url) === "/v1/home"
      ? json(200, HOME)
      : json(200, body);

function authOf(call: number): string | null {
  return new Headers(fetchMock.mock.calls[call]![1]?.headers).get("authorization");
}

async function signIn(token: string) {
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

beforeEach(() => {
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  fetchMock.mockReset(); // also drops a test's mockImplementation (vitest 3 restores the vi.fn one)
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dashboard shell", () => {
  it("signs in, stores the token, sends it on later calls, and lands on Home at /", async () => {
    render(<App />);
    await signIn("good-token");
    expect(await screen.findByText("bennys-laptop")).toBeTruthy();
    expect(screen.getByLabelText("role").textContent).toBe("Member");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening), U1$/);
    expect(location.pathname).toBe("/");
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(sessionStorage.getItem("hive.token")).toBe("good-token");
    expect(fetchMock.mock.calls[0]![0]).toBe("/v1/status");
    expect(authOf(0)).toBe("Bearer good-token");

    await apiFetch("/v1/facts");
    // Home makes its own calls first; ours is the last one.
    const last = fetchMock.mock.calls.length - 1;
    expect(fetchMock.mock.calls[last]![0]).toBe("/v1/facts");
    expect(authOf(last)).toBe("Bearer good-token");
  });

  it("shows the Review nav link to members too, counting their own candidates, and /review opens it", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    const own = { candidates: [{ id: "c1" }, { id: "c2" }], flagged: [], last_distill_at: null };
    fetchMock.mockImplementation(async (url: RequestInfo | URL) =>
      String(url) === "/v1/status" ? json(200, STATUS) : String(url) === "/v1/home" ? json(200, HOME) : json(200, own),
    );
    const { unmount } = render(<App />);
    await screen.findByText("bennys-laptop");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    const main = screen.getByRole("navigation", { name: "Main" });
    expect((await within(main).findByLabelText("2 waiting")).closest("a")!.getAttribute("href")).toBe("/review");
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/v1/review/queue?limit=100")).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/v1/stats"))).toBe(false);
    unmount();

    fetchMock.mockImplementation(asCurator({ candidates: [], flagged: [], last_distill_at: null }));
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Review" }));
    expect(location.pathname).toBe("/review");
    expect(await screen.findByText("Nothing waiting for review")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows the Playbooks nav link to curators only, and /playbooks opens it", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    const { unmount } = render(<App />);
    await screen.findByText("bennys-laptop");
    expect(screen.queryByRole("link", { name: "Playbooks" })).toBeNull();
    unmount();

    fetchMock.mockImplementation(asCurator({ playbooks: [], facts: [], has_more: false, repos: [] }));
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Playbooks" }));
    expect(location.pathname).toBe("/playbooks");
    expect(await screen.findByRole("heading", { name: "No playbooks yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Playbooks" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows Review's Out of date tab to curators only, and /stale opens it under Review", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    history.replaceState(null, "", "/stale");
    const { unmount } = render(<App />);
    await screen.findByText("bennys-laptop");
    expect(screen.queryByRole("link", { name: "Out of date" })).toBeNull();
    unmount();

    fetchMock.mockImplementation(asCurator({ facts: [], has_more: false, stale_days: 60 }));
    history.replaceState(null, "", "/stale");
    render(<App />);
    expect(await screen.findByText("Nothing is out of date")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "Review pages" });
    expect(within(tabs).getByRole("link", { name: "Out of date" }).getAttribute("aria-current")).toBe("page");
    expect(within(tabs).getByRole("link", { name: "New" }).getAttribute("aria-current")).toBeNull();
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getByRole("link", { name: "Review" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows the Teams nav link to curators only, and /teams opens it", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    const { unmount } = render(<App />);
    await screen.findByText("bennys-laptop");
    expect(screen.queryByRole("link", { name: "Teams" })).toBeNull();
    unmount();

    fetchMock.mockImplementation(asCurator({ teams: [] }));
    render(<App />);
    fireEvent.click(await screen.findByRole("link", { name: "Teams" }));
    expect(location.pathname).toBe("/teams");
    expect(await screen.findByRole("heading", { name: "No teams yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Teams" }).getAttribute("aria-current")).toBe("page");
  });

  it("shows Admin's Tokens tab to curators only, and /tokens opens it", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    history.replaceState(null, "", "/repos");
    const { unmount } = render(<App />);
    await screen.findByText("bennys-laptop");
    expect(screen.queryByRole("link", { name: "Tokens" })).toBeNull();
    unmount();

    fetchMock.mockImplementation(asCurator({ repos: [], instances: [{ ...STATUS.instance, role: "curator", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, revoked_at: null, rotated_at: null }] }));
    history.replaceState(null, "", "/repos");
    render(<App />);
    const tabs = await screen.findByRole("navigation", { name: "Admin pages" });
    fireEvent.click(within(tabs).getByRole("link", { name: "Tokens" }));
    expect(location.pathname).toBe("/tokens");
    expect(await screen.findByRole("heading", { name: "Tokens" })).toBeTruthy();
    expect(within(document.querySelector('tr[data-id="i1"]') as HTMLElement).getByText("you")).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Admin pages" })).getByRole("link", { name: "Tokens" }).getAttribute("aria-current")).toBe("page");
  });

  it("sign-in says what to paste and where a token comes from", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hive");
    expect(screen.getByText("Paste your Hive token. Ask whoever runs Hive for one.")).toBeTruthy();
    expect(screen.getByText(/Running Hive yourself\?/).textContent).toContain("mint-token");
  });

  it("an unknown page says so and links to Facts", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    history.replaceState(null, "", "/nowhere");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();
    expect(screen.getByText("/nowhere").closest(".lede")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Go to Facts" }));
    expect(location.pathname).toBe("/facts");
  });

  it("uses a token already stored in this tab without asking again", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    render(<App />);
    expect(await screen.findByText("bennys-laptop")).toBeTruthy();
    expect(authOf(0)).toBe("Bearer good-token");
  });

  it("rejects a bad token and stores nothing", async () => {
    render(<App />);
    await signIn("bad-token");
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't accept/);
    expect(sessionStorage.getItem("hive.token")).toBeNull();
    expect(screen.queryByText("bennys-laptop")).toBeNull();
  });

  it("sign out clears the token and returns to sign-in", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(sessionStorage.getItem("hive.token")).toBeNull();
    expect(screen.getByLabelText("Token")).toBeTruthy();
  });

  it("a 401 later on clears the token and returns to sign-in", async () => {
    sessionStorage.setItem("hive.token", "good-token");
    render(<App />);
    await screen.findByText("bennys-laptop");
    fetchMock.mockResolvedValueOnce(json(401, { error: "revoked" }));
    await expect(apiFetch("/v1/facts")).rejects.toThrow(/401/);
    expect(sessionStorage.getItem("hive.token")).toBeNull();
    expect(await screen.findByLabelText("Token")).toBeTruthy();
  });
});
