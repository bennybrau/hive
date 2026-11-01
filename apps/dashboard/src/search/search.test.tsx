import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fact } from "../facts/query";
import type { Hit } from "./query";
import { Search } from "./Search";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function fact(id: string, text: string): Fact {
  return {
    id, text, kind: "gotcha", scope: "global", locus: [], origin: "authored", status: "active",
    status_note: null, author_user_id: "u1", recorded_at: "2026-10-01T12:00:00Z",
  };
}

const DOC: Hit = {
  source: "doc", id: "d1", snippet: "set <b>GATE_POLICY</b>=strict", score: 0.03, repo_key: "gh/acme/proj",
  path: "docs/settings.md", line_start: 5, line_end: 8, sha: SHA, remote_url: "git@github.com:acme/proj.git",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let reply: () => Response;
const fetchMock = vi.fn(async (_input: RequestInfo | URL) => reply());

function lastSearch(): Record<string, string> {
  const urls = fetchMock.mock.calls.map(([u]) => new URL(String(u), "http://hive")).filter((u) => u.pathname === "/v1/search");
  expect(urls.length).toBeGreaterThan(0);
  return Object.fromEntries(urls.at(-1)!.searchParams);
}

function results(facts: Fact[], hits: Hit[]) {
  reply = () => json({ mode: "hybrid", facts, results: hits });
}

beforeEach(() => {
  history.replaceState(null, "", "/search");
  results([], []);
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("search view", () => {
  it("shows a hint and asks nothing until there's a query", () => {
    render(<Search />);
    expect(screen.getByText(/Type a question/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("searches every source, then the chips narrow source= and the page URL", async () => {
    render(<Search />);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: " gate " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(lastSearch()).toEqual({ q: "gate", source: "all", k: "20", include_candidates: "true" }));
    expect(location.search).toBe("?q=gate");

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(lastSearch().source).toBe("fact,commit,doc"));
    expect(new URLSearchParams(location.search).get("source")).toBe("fact,commit,doc");
    expect(screen.getByRole("button", { name: "History" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    await waitFor(() => expect(lastSearch().source).toBe("all"));
    expect(location.search).toBe("?q=gate");
  });

  it("won't turn off the last chip", async () => {
    history.replaceState(null, "", "/search?q=gate&source=doc");
    render(<Search />);
    const doc = screen.getByRole("button", { name: "Docs" });
    expect(doc.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(doc);
    expect(doc.getAttribute("aria-pressed")).toBe("true");
    expect(new URLSearchParams(location.search).get("source")).toBe("doc");
    await waitFor(() => expect(lastSearch().source).toBe("doc"));
  });

  it("lists facts linking to /facts/<id>, and each kind of hit", async () => {
    results([fact("f1", "the factory deploys to Cloud Run")], [
      DOC,
      { source: "commit", id: "c1", snippet: "<b>initial</b> import", score: 0.02, repo_key: "gh/acme/proj", ref: SHA, subject: "initial import" },
      { source: "conversation", id: "e1", snippet: "we talked about the gate", score: 0.01, session_id: "s-42", created_at: "2026-10-05T00:00:00Z" },
      { source: "history", id: "e2", snippet: "session summary", score: 0.01, session_id: "s-7", created_at: "2026-10-04T00:00:00Z" },
    ]);
    history.replaceState(null, "", "/search?q=gate");
    render(<Search />);

    const facts = await screen.findByRole("region", { name: "Facts" });
    expect(within(facts).getByRole("link", { name: "the factory deploys to Cloud Run" }).getAttribute("href")).toBe("/facts/f1");

    const res = screen.getByRole("region", { name: "Results" });
    const item = (s: string) => res.querySelector(`li[data-source="${s}"]`) as HTMLElement;
    expect(within(item("doc")).getByRole("link", { name: "docs/settings.md:5-8" }).getAttribute("href")).toBe(
      `https://github.com/acme/proj/blob/${SHA}/docs/settings.md#L5-L8`,
    );
    expect(within(item("doc")).getByText("GATE_POLICY").tagName).toBe("MARK");
    expect(within(item("commit")).getByText("initial import")).toBeTruthy();
    expect(within(item("commit")).getByText(SHA.slice(0, 10))).toBeTruthy();
    expect(within(item("conversation")).getByText("s-42")).toBeTruthy();
    expect(within(item("history")).getByText("s-7")).toBeTruthy();
  });

  it("shows the doc path without a link when the remote isn't GitHub", async () => {
    results([], [{ ...DOC, remote_url: "git@gitlab.example.com:team/proj.git" }]);
    history.replaceState(null, "", "/search?q=gate");
    render(<Search />);
    expect(await screen.findByText("docs/settings.md:5-8")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "docs/settings.md:5-8" })).toBeNull();
  });

  it("says when nothing matched, and when the hive failed", async () => {
    history.replaceState(null, "", "/search?q=nothing");
    const { unmount } = render(<Search />);
    expect(await screen.findByText("No results.")).toBeTruthy();
    unmount();

    reply = () => json({ error: "boom" }, 500);
    render(<Search />);
    expect((await screen.findByRole("alert")).textContent).toContain("500");
  });
});
