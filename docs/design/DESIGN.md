# Hive dashboard design

The one reference for how the dashboard looks, reads and behaves. Every dashboard PR follows it; a change to it is its own PR.

Goal: any engineer, at any level, can open Hive and within a minute say what Hive knows, what is waiting for them, and what a button will do, without reading the manual.

Mockups (static HTML, real Hive data from Nov 12): `docs/design/mockups/` — Home, Knowledge, Review, Admin › Notifications, each in dark and light, at 1440 and 390.

## Principles

1. **Say who gets it and what happens next, in plain words.** Every decision screen answers both before the button.
2. **One job per screen, one filled button.**
3. **The fact first, the evidence second, the internals on request.** Ids, hashes, paths and raw timestamps live behind *Details*.
4. **Explain in place.** One line under each page title says what the page is for. Each Hive word has a short hint. Empty states say what would appear and how.
5. **The same on a phone.** Nothing wider than the screen at 320; every control 44px tall at phone width.

## Structure

Left sidebar on desktop (232px), top bar with a Menu button under 860px.

| Menu | Who | Replaces |
|---|---|---|
| Home | everyone | new (`/` used to redirect to `/facts`) |
| Knowledge | everyone | Facts + Search |
| *Curator* group: Review (with count) | curators | Review + Stale (tabs New / Out of date) |
| Playbooks | curators | Playbooks |
| Teams | curators | Teams |
| Admin | curators | Repos + Stats + Settings (sub-tabs Sources / Usage and cost / Notifications) |

The person's name and role sit at the foot of the sidebar; Sign out is in its menu. When a page is rebuilt it moves to its new address and the old one redirects: `/facts` and `/search` → `/knowledge`, `/stale` → `/review/out-of-date`, `/repos` → `/admin/sources`, `/stats` → `/admin/usage`, `/settings` → `/admin/notifications`.

**As built in the foundation step:** the sidebar, the top bar and section tabs, with every page at its old address. Home is not in the menu yet; it arrives with its own page, and until then `/` opens Knowledge › Facts. Members see Knowledge and Admin › Sources only.

## Tokens

Source: tasteskill deal for a developer tool — palette **Forest and lime** (`forest-pale-lime`), type **Reddit Sans + JetBrains Mono**, radius **sharp**. Light theme = the same palette's own inverse field plus a lime tint. The dashboard follows the OS setting (`prefers-color-scheme`). Fonts are bundled in the image (no Google Fonts call from a private network).

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#0f1f10` | `#f4f5f2` |
| `--surface` | `#162a17` | `#ffffff` |
| `--raise` (hover, quote, tracks) | `#1d351e` | `#ecedec` |
| `--line` | `#2c452d` | `#dadfd9` |
| `--ink` | `#ffffff` | `#0f1f10` |
| `--muted` (labels, meta; never body text) | `#b8c2b8` | `#556155` |
| `--accent` (links, focus ring, bars, current tab) | `#c6f19d` | `#2d6a1f` |
| `--action` / `--action-ink` (the one filled button) | `#c6f19d` / `#0f1f10` | `#0f1f10` / `#ffffff` |
| `--tint` / `--tint-ink` (current nav item, "who gets it" badge, selected row) | lime 12% / `#c6f19d` | `#e8f8d6` / `#1f4a14` |
| `--warn` / `--warn-tint` | `#f2c66d` / 12% | `#8a5a00` / `#fdf1d8` |
| `--bad` | `#ff9c8a` | `#b3261e` |

Spacing: 4, 8, 12, 16, 24, 32, 48, 64. Radius: 4 (buttons, fields), 6 (rows, nav items), 8 (cards). Badges are pills (13px radius).

Type: body 16px/1.5; meta and labels 13px weight 500; small 14px; lead 18px; fact text in a detail or review card 20–22px; h2 20px; h1 30px (26px on phone); stat numbers 36px. Weights 400/500 only (600 for the brand and counts). Sentence case everywhere. Nothing under 13px. Mono only for ids and code, 13px.

Contrast: body text 7:1 or better, muted text 4.5:1 or better, on every surface it sits on.

## Components (`apps/dashboard/src/ui/`)

- **Button** — `secondary` (default: surface, 1px line) and `primary` (filled, `--action`). Exactly one primary per view. `quiet` for tertiary actions (Retire, Change…, prev/next). Heights 40 (48 for the main decision, 44 on phone). Label = verb + object, and a decision button says where it goes: "Approve for Repo: hive".
- **Field** — label above (15px/500), 48px input, help line under it, error under its own field. Saved secrets show an empty password field with placeholder "Saved. Paste a new one to replace it" and a "Saved <date>. Hive never shows it again." line.
- **Badge** — `who` (tint) for who gets it; plain for kind and status; `warn` for out of date / source changed.
- **Card** — surface, 1px line, 8px radius, 24px padding. Never nested more than two deep.
- **FactRow** — text 16px, then a meta line: who-gets-it badge, kind, where it came from, when / how often used. Whole row is the link. Selected row: tint + accent border.
- **Tabs** — underline style, count after the label.
- **PageHeader** — h1, one lede line, optional single action on the right.
- **EmptyState** — what would appear here, and how it gets here.
- **Details** — a disclosure (`<details>`) for internals; 44px summary.

Motion: hover changes background; press moves 1px; nothing animates on scroll; `prefers-reduced-motion` respected.

Accessibility: skip link first; focus ring 2px accent with 2px offset; the phone Menu button carries `aria-expanded`; current nav item `aria-current="page"`; every control named.

## Words

Labels and hints live in one file, `apps/dashboard/src/words.ts`. API values do not change.

| API value | On screen | Hint |
|---|---|---|
| scope `global` | Everyone | Every agent, in any repo |
| scope `repo:gh/o/name` | Repo: name | Agents working in the name repo |
| scope `team:x` | Team: X | X's agents get it first; others can still find it |
| scope `personal:u` | Just me | Only your own agents |
| status `candidate` | Waiting for review | Not given to agents yet |
| status `active` | Live | Agents are given this |
| status `superseded` | Replaced | A newer fact took its place |
| status `retracted` | Retired | Withdrawn or rejected; kept as history |
| origin `authored` | Written by a person | |
| origin `distilled` | Learned from a conversation | Hive proposed it from something a person said |
| origin `ingested` | Read from the repo | Taken from the repo's docs or code |
| kind `invariant` | Must stay true | |
| kind `gotcha` | Pitfall | |
| kind `system` | How it works | |
| kinds `decision`, `preference`, `convention` | unchanged, capitalised | |
| anchors | Where this comes from | |
| provenance | Details | |
| bot said / you said | The agent said / *name* said | |
| stale | Out of date? | Nobody has used it in 60 days |
| ingest now | Read again now | |
| verify `verified` / `drifted` / `missing` / `unverifiable_here` | Still matches / Source changed / Source gone / Can't check from here | |
| distill / embed (usage) | Learning from conversations / Indexing for search | |
| Fix… | Edit… | |
| curator | Curator | Approves what Hive learns before agents get it |

Dates: relative ("17 hours ago", "Nov 7" past a week) with the full date and time on hover.

## Screens

- **Home** — greeting and one-line explanation of Hive. *Needs you* (curators): waiting for review (the page's one primary button), possibly out of date, sources. *What Hive knows*: live facts as bars by who gets them, each with its hint; Teams (or how to create one); this month's spend in one sentence. *Recently added*: three FactRows. Non-curators see what Hive knows, their own facts, and how to add one; no review counts or cost.
- **Knowledge** — one big search box; filter chips (Live on by default, Who gets it, Repo, Kind, Came from); result tabs Facts / Docs / Commits / Conversations with counts; FactRows on the left, the selected fact on the right (badges, the fact at 20px, Who gets it / Came from / Used, what the person said as a quote, Edit… / Change who gets it… / Retire, Details). Primary button: Add a fact.
- **Review** — tabs New / Out of date. One card: position and prev/next; the proposed fact at 22px; *Who gets it* box with Change…; *Why Hive thinks so* = the person's own words as a quote with who, where and when; the agent's side folded. Footer: **Approve for <level>** (primary), Edit…, Reject, and "? keys". On phone the footer is fixed to the bottom: Approve full width, Edit and Reject below.
- **Admin** — sub-tabs. Forms follow the Field recipe; one primary Save per form, named for what it saves; a status line beside it.

## Checks

On every route at 1440 and 390, light and dark: no raw API value as visible text; nothing under 13px; no sideways scroll; 44px targets at phone width; contrast as above; one primary button per view. The tasteskill checker (`consistency.mjs --quick`) runs against the mockups; its website-only checks (hero, one section per screen, call to action, share tags) do not apply.

Waived on purpose:
- `button-styles` on Knowledge: filter chips are toggles, not buttons, and are meant to look different from Add a fact and Edit….
- `button-styles` on the phone for the skip link: it is off screen until focused.

As of the Nov 12 mockups, every other applicable check passes on all four screens, in dark and light, at 1440 and 390.
