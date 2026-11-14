// Every word the dashboard shows for a value the API sends. API values never change; only what a person
// reads does. The table and the reasons are in docs/design/DESIGN.md § Words. Scope labels ("Who gets it")
// live in levels/levels.ts (levelLabel) and are re-exported here so pages import one place.
export { levelLabel } from "./levels/levels";

export interface Word {
  label: string;
  /** One line shown next to the label (a tooltip or a hint line). Empty when the label says it all. */
  hint: string;
}

const w = (label: string, hint = ""): Word => ({ label, hint });

export const STATUS: Record<string, Word> = {
  candidate: w("Waiting for review", "Not given to agents yet"),
  active: w("Live", "Agents are given this"),
  superseded: w("Replaced", "A newer fact took its place"),
  retracted: w("Retired", "Withdrawn or rejected; kept as history"),
};

export const ORIGIN: Record<string, Word> = {
  authored: w("Written by a person"),
  distilled: w("Learned from a conversation", "Hive proposed it from something a person said"),
  ingested: w("Read from the repo", "Taken from the repo's docs or code"),
};

export const KIND: Record<string, Word> = {
  decision: w("Decision"),
  preference: w("Preference"),
  convention: w("Convention"),
  invariant: w("Must stay true"),
  gotcha: w("Pitfall"),
  system: w("How it works"),
};

/** Whether a fact's source still says what the fact quoted. */
export const VERIFY: Record<string, Word> = {
  verified: w("Still matches"),
  drifted: w("Source changed", "The lines this fact quotes have changed since"),
  missing: w("Source gone", "The file or lines this fact quotes no longer exist"),
  unverifiable_here: w("Can't check from here", "Hive can't read this source"),
  unverified: w("Not checked yet"),
};

/** Background jobs, as named on Usage and cost. */
export const JOB: Record<string, Word> = {
  distill: w("Learning from conversations", "Reading what people said and proposing facts"),
  embed: w("Indexing for search", "Free: runs on this machine"),
};

export const ROLE: Record<string, Word> = {
  curator: w("Curator", "Approves what Hive learns before agents get it"),
  member: w("Member"),
  worker: w("Worker", "A background job's token"),
  /** A team role (members and reviewers); the others are token roles. */
  reviewer: w("Reviewer"),
};

/** Where a review anchor's words were said (`anchors[].source.where`); `other` adds nothing. */
export const WHERE: Record<string, Word> = {
  factory_plan_note: w("in a factory plan approval"),
  factory_chat: w("in a factory run's chat"),
  factory_run: w("in a factory run"),
  conversation: w("in a conversation with Hermes"),
  commit: w("in a commit"),
  other: w(""),
};

/** A review of a fact (`reviews[].action`), as its history tells it. */
export const REVIEW: Record<string, Word> = {
  approve: w("Approved"),
  fix: w("Approved with a fix"),
  reject: w("Rejected"),
  keep: w("Kept", "Confirmed it is still true"),
  retire: w("Retired"),
  pin: w("Pinned"),
  unpin: w("Unpinned"),
  move: w("Moved", "Changed who gets it"),
};

/** Fixed phrases that replace internal words on screen. */
export const PHRASE = {
  anchors: "Where this comes from",
  provenance: "Details",
  agentSaid: "The agent said",
  personSaid: (name: string) => `${name} said`,
  stale: "Out of date?",
  staleHint: "Nobody has used it in 60 days",
  ingestNow: "Read again now",
  ingesting: "Reading…",
  edit: "Edit…",
  selectedFact: "Selected fact",
  close: "Close",
  factsBack: "Facts",
  whoGetsIt: "Who gets it",
  used: "Used",
  approved: "Approved",
  written: "Written",
  replaces: "Replaces",
  replacedBy: "Replaced by",
} as const;

/** The word for a value; an unknown value (a newer server) shows as itself rather than blank. */
export function word(table: Record<string, Word>, value: string): Word {
  return table[value] ?? w(value);
}

/** How often agents were given a fact: "Not used yet", "Used once", "Used 5 times". */
export function usedTimes(n: number): string {
  if (n <= 0) return "Not used yet";
  return n === 1 ? "Used once" : `Used ${n} times`;
}

/** The pane's Used line: "Not used yet", "Once, last 2 hours ago", "5 times, last yesterday". */
export function usedLine(n: number, last: string | null | undefined, now: number = Date.now()): string {
  if (n <= 0) return "Not used yet";
  const times = n === 1 ? "Once" : `${n} times`;
  return last ? `${times}, last ${when(last, now).text}` : times;
}

/** Under a quote: who said it, where and when ("Jon, in a factory plan approval, 2 hours ago"); empty parts are left out. */
export function saidCaption(source: { author: string | null; where: string; at: string }, now: number = Date.now()): string {
  const line = [source.author, WHERE[source.where]?.label ?? "", when(source.at, now).text].filter(Boolean).join(", ");
  return line && `${line[0]!.toUpperCase()}${line.slice(1)}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
];

/**
 * A date as a person reads it: "just now", "3 hours ago", "yesterday", "4 days ago" within a week, then
 * "Nov 7" this year or "Nov 7, 2025" before it. `title` is the full date and time, for a hover.
 * Future times (clock skew) read as "just now". An unparseable value comes back as itself.
 */
export function when(iso: string, now: number = Date.now()): { text: string; title: string } {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { text: iso, title: iso };
  const date = new Date(t);
  const title = date.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
  const secs = (now - t) / 1000;
  if (secs < 45) return { text: "just now", title };
  let n = secs;
  for (const [unit, per] of UNITS) {
    if (n < per) return { text: new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(-Math.round(n), unit), title };
    n /= per;
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const text = date.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return { text, title };
}

/** Raw API values that must never appear as visible text on a page (the guard test reads this). */
export const RAW_VALUES: readonly string[] = [
  ...Object.keys(STATUS),
  ...Object.keys(ORIGIN),
  "invariant",
  "gotcha",
  ...Object.keys(VERIFY),
  "global",
  ...Object.keys(JOB),
];
