// The plain-words guard: no page shows a raw API value (RAW_VALUES), a raw ISO timestamp or a full commit hash as text.
// Each page renders against a fixture holding every status, origin, kind and anchor state; add pages to PAGES.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Facts } from "./facts/Facts";
import type { Fact } from "./facts/query";
import { KINDS, ORIGINS, STATUSES } from "./facts/query";
import { Search } from "./search/Search";
import { RAW_VALUES, VERIFY } from "./words";

const SHA = "0123456789abcdef0123456789abcdef01234567";

// One fact per status, origin and kind (cycled), half of them for everyone and half for a repo.
const FACTS: Fact[] = KINDS.map((kind, i) => ({
  id: `fact-${i}`,
  text: `Fixture fact number ${i}`,
  kind,
  scope: i % 2 ? "repo:acme/widgets" : "global",
  locus: ["src/a.ts"],
  origin: ORIGINS[i % ORIGINS.length]!,
  status: STATUSES[i % STATUSES.length]!,
  status_note: null,
  author_user_id: "u1",
  recorded_at: "2026-10-01T12:00:00Z",
}));

const DETAIL = {
  fact: FACTS[0]!,
  anchors: Object.keys(VERIFY).map((v, i) => ({
    id: `a${i}`, episode_id: null, repo_key: "acme/widgets", commit_sha: SHA, path: `src/f${i}.ts`, line_start: 1, line_end: 2,
    quote: "const a = 1;", verify_status: v, verified_at: "2026-10-02T00:00:00Z", verify_note: null, found_line: 1,
    remote_url: "git@github.com:acme/widgets.git",
  })),
  reviews: [{ action: "fix", note: "tightened wording", new_text: null, reviewer_user_id: "curator1", created_at: "2026-10-03T00:00:00Z" }],
  supersedes: [{ id: "old-1", text: "An older fact", status: "superseded", recorded_at: "2026-09-01T00:00:00Z" }],
  superseded_by: [{ id: "old-2", text: "A withdrawn fact", status: "retracted", recorded_at: "2026-09-02T00:00:00Z" }],
};

const HITS = [
  { source: "doc", id: "d1", snippet: "a <b>doc</b> line", score: 0.03, repo_key: "acme/widgets", path: "docs/a.md", line_start: 5, line_end: 8, sha: SHA, remote_url: "git@github.com:acme/widgets.git" },
  { source: "commit", id: "c1", snippet: "first import", score: 0.02, repo_key: "acme/widgets", ref: SHA, subject: "first import" },
  { source: "conversation", id: "e1", snippet: "we talked", score: 0.01, session_id: "s-42", created_at: "2026-10-05T00:00:00Z" },
  { source: "history", id: "e2", snippet: "a summary", score: 0.01, session_id: "s-7", created_at: "2026-10-04T00:00:00Z" },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://hive").pathname;
  if (path === "/v1/repos") return json({ repos: [{ key: "acme/widgets" }] });
  if (path === "/v1/teams") return json({ teams: [] });
  if (path === "/v1/teams/mine") return json({ teams: [] });
  if (path === "/v1/search") return json({ mode: "hybrid", facts: FACTS, results: HITS });
  if (path === "/v1/facts") return json({ facts: FACTS, has_more: false });
  if (path.startsWith("/v1/facts/")) return json(DETAIL);
  return new Response("{}", { status: 404 });
});

/** Each page: put it on screen at a URL and wait until its data has loaded. */
const PAGES: { name: string; render: () => Promise<void> }[] = [
  {
    name: "Facts",
    render: async () => {
      history.replaceState(null, "", "/facts/fact-0");
      render(<Facts />);
      await screen.findByText("Fixture fact number 5");
      await screen.findByText("tightened wording");
    },
  },
  {
    name: "Search",
    render: async () => {
      history.replaceState(null, "", "/search?q=fixture");
      render(<Search />);
      await screen.findByText("Fixture fact number 5");
      await screen.findByText("s-42");
    },
  },
];

const ISO = /\d{4}-\d\d-\d\dT\d\d:/;
/** A full commit hash; pages show the first 7 characters. */
const FULL_SHA = /\b[0-9a-f]{40}\b/;
const RAW = RAW_VALUES.map((w) => ({ w, re: new RegExp(`\\b${w}\\b`) }));

/** Every visible text node's content (attributes such as title and dateTime aren't text nodes). */
function texts(root: Node): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n.textContent ?? "");
  return out;
}

/** The first leak on the page, as `page: "word"`, or null. */
function leak(page: string): string | null {
  for (const t of texts(document.body)) {
    const raw = RAW.find(({ re }) => re.test(t));
    if (raw) return `${page}: "${raw.w}"`;
    const iso = ISO.exec(t);
    if (iso) return `${page}: "${t}"`;
    if (FULL_SHA.test(t)) return `${page}: full commit hash in "${t}"`;
  }
  return null;
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("plain words", () => {
  it.each(PAGES)("$name shows no raw API value, ISO date or full commit hash", async ({ name, render: show }) => {
    await show();
    expect(leak(name)).toBeNull();
  });
});
