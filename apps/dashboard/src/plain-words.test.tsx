// The plain-words guard: no page shows a raw API value (RAW_VALUES), a raw ISO timestamp or a full commit hash as text.
// Each page renders against a fixture holding every status, origin, kind, anchor state and job; add pages to PAGES.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { Facts } from "./facts/Facts";
import type { Fact } from "./facts/query";
import { KINDS, ORIGINS, STATUSES } from "./facts/query";
import { Playbooks } from "./playbooks/Playbooks";
import { Repos, type Repo } from "./repos/Repos";
import { Search } from "./search/Search";
import { Settings } from "./settings/Settings";
import { SignIn } from "./SignIn";
import { Stats, type StatsBody } from "./stats/Stats";
import { Teams } from "./teams/Teams";
import { Tokens } from "./tokens/Tokens";
import { JOB, RAW_VALUES, VERIFY } from "./words";

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

const AGO = new Date(Date.now() - 3 * 3600_000).toISOString();

// Two repos, so each anchor state shows once with a non-zero count and once with zero.
const REPOS: Repo[] = ["acme/widgets", "acme/gears"].map((key, i) => ({
  key, source: "path" as const, url: null, has_token: false, last_fetched_at: null, host_path: `/srv/${key}`, remote_url: null, default_branch: "main", last_ingested_sha: SHA, last_ingested_at: i ? null : AGO,
  ingest_error: null, docs: 3, chunks: 9, commits: 4,
  anchors: Object.fromEntries(Object.keys(VERIFY).map((v) => [v, i ? 0 : 2])) as Repo["anchors"],
}));
REPOS.push({
  ...REPOS[0]!, key: "gh/acme/cloud", source: "url", url: "https://github.com/acme/cloud", has_token: true, last_fetched_at: AGO, host_path: null,
});

const count = (keys: readonly string[]) => Object.fromEntries(keys.map((k, i) => [k, i + 1]));
const STATS: StatsBody = {
  days: 30,
  since: "2026-10-04T00:00:00.000Z",
  facts: {
    by_status: count(STATUSES),
    by_origin: count(ORIGINS),
    by_scope: count(["global", "personal", "repo:acme/widgets", "team:billing"]),
    per_day: [{ day: "2026-11-01", count: 3 }],
  },
  cost: Object.keys(JOB).map((job) => ({ day: "2026-11-01", job, calls: 2, input_tokens: 100, output_tokens: 10, cost_usd: 0.01 })),
  cost_totals: Object.keys(JOB).map((job) => ({ job, calls: 2, input_tokens: 100, output_tokens: 10, cost_usd: 0.01 })),
  workers: [
    { id: "w1", name: "worker-a", last_seen_at: AGO },
    { id: "w2", name: "worker-b", last_seen_at: null },
  ],
  backlog: { candidates: 2, oldest_candidate_at: AGO, distill_queued: 1, oldest_queued_at: AGO },
};

const DIGEST = {
  enabled: true, time: "07:30", timezone: "Europe/Berlin", dashboard_url: "https://hive.example.com",
  channels: { email: null, telegram: { chat_id: "-100" } }, last_sent_at: AGO, last_item_count: 4, last_error: null,
};

const TEAMS = [
  { key: "billing", name: "Billing", created_at: "2026-10-01T00:00:00Z", members: [{ user_id: "ana", role: "member" }, { user_id: "bo", role: "reviewer" }], repos: ["acme/widgets"] },
];

const INSTANCES = [
  { id: "i1", name: "laptop", user_id: "u1", role: "curator", created_at: "2026-10-01T00:00:00Z", last_seen_at: AGO, revoked_at: null, rotated_at: AGO },
  { id: "i2", name: "worker-a", user_id: "hive", role: "worker", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, revoked_at: null, rotated_at: null },
  { id: "i3", name: "old-laptop", user_id: "ana", role: "member", created_at: "2026-10-01T00:00:00Z", last_seen_at: AGO, revoked_at: AGO, rotated_at: null },
];

const playbook = (id: string, over: object) => ({
  id, scope: "global", title: `Playbook ${id}`, applies_paths: ["src/**"], applies_words: ["deploy"], steps: [{ text: "Step one", fact_ids: [] }],
  pitfalls: [], status: "active", supersedes: null, author_user_id: "u1", created_at: "2026-11-01T12:00:00Z", ...over,
});
const PLAYBOOKS = [playbook("p1", {}), playbook("p2", { scope: "repo:acme/widgets" })];
const RETIRED = playbook("p3", { scope: "repo:acme/widgets", title: "Old playbook", status: "retracted" });

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://hive").pathname;
  if (path === "/v1/status") return json({ version: "t", instance: { id: "i1", name: "laptop", user_id: "u1", role: "curator" } });
  if (path === "/v1/repos") return json({ repos: REPOS });
  if (path === "/v1/repos/files") return json({ files: [] });
  if (path === "/v1/stats") return json(STATS);
  if (path === "/v1/settings") return json({ review_digest: DIGEST });
  if (path === "/v1/playbooks") return json({ playbooks: PLAYBOOKS });
  if (path === "/v1/playbooks/p3") return json({ playbook: RETIRED });
  if (path === "/v1/review/count") return json({ count: 0 });
  if (path === "/v1/teams") return json({ teams: TEAMS });
  if (path === "/v1/instances") return json({ instances: INSTANCES });
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
  {
    name: "Sources",
    render: async () => {
      render(<Repos role="curator" />);
      await screen.findByText("acme/gears");
    },
  },
  {
    name: "Usage and cost",
    render: async () => {
      render(<Stats role="curator" />);
      await screen.findByText("worker-b");
    },
  },
  {
    name: "Usage and cost (member)",
    render: async () => {
      render(<Stats role="member" />);
    },
  },
  {
    name: "Notifications",
    render: async () => {
      render(<Settings role="curator" />);
      await screen.findByLabelText("Last digest");
    },
  },
  {
    name: "Teams",
    render: async () => {
      render(<Teams role="curator" />);
      await screen.findByText("bo");
    },
  },
  {
    name: "Tokens",
    render: async () => {
      render(<Tokens role="curator" selfId="i1" />);
      await screen.findByText("old-laptop");
    },
  },
  {
    name: "Playbooks list",
    render: async () => {
      render(<Playbooks role="curator" path="/playbooks" />);
      await screen.findByText("Playbook p2");
    },
  },
  {
    name: "Playbook view (retired)",
    render: async () => {
      render(<Playbooks role="curator" path="/playbooks/p3" />);
      await screen.findByRole("heading", { name: "Old playbook" });
    },
  },
  {
    name: "New playbook",
    render: async () => {
      render(<Playbooks role="curator" path="/playbooks/new" />);
      await screen.findByLabelText("Title");
    },
  },
  {
    name: "Sign-in",
    render: async () => {
      render(<SignIn onSignedIn={() => {}} />);
    },
  },
  {
    name: "Not found",
    render: async () => {
      sessionStorage.setItem("hive.token", "t");
      history.replaceState(null, "", "/nowhere");
      render(<App />);
      await screen.findByRole("heading", { name: "Not found" });
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
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("plain words", () => {
  it.each(PAGES)("$name shows no raw API value, ISO date or full commit hash", async ({ name, render: show }) => {
    await show();
    expect(leak(name)).toBeNull();
  });
});
