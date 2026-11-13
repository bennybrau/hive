# Hive dashboard: user manual

The dashboard is the web view of your team's hive. You use it to **see what the hive knows**, **search it**, and,
as a curator, **decide what the hive is allowed to tell everyone's assistants**.

Most of the hive's work happens without you. Your Hermes sessions are recalled from and distilled into it
automatically. The dashboard is where a person looks in and decides.

- [Signing in](#signing-in)
- [Finding your way around](#finding-your-way-around): the menu and where each page lives
- [Words you'll see](#words-youll-see)
- [Facts](#facts): browse everything the hive knows
- [Search](#search): ask across facts, conversations, commits and docs
- [Repos](#repos): the code and docs the hive has read
- [Review](#review-curators): approve, fix or reject what's new (curators)
- [Stats](#stats-curators): cost, growth and health (curators)
- [Settings](#settings-curators): the daily review digest (curators)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Who sees what

| | Member | Curator |
|---|---|---|
| Knowledge (Facts, Search), Admin › Sources (Repos) | ✓ | ✓ |
| **Ingest now** on Repos | | ✓ |
| Review (New, Out of date), Playbooks, Teams, Admin › Usage and cost (Stats), Admin › Notifications (Settings) | | ✓ |

Everyone sees shared facts (`global` and every `repo:…`) plus **their own** personal facts. Nobody, curators
included, ever sees another person's personal facts.

## Signing in

![Sign-in page](img/signin.png)

Open the hive's address in a browser, for example `http://hive.example.internal:8800/`, and paste
your token. Whoever runs the hive gives you one:

```sh
docker compose exec hive node dist/cli/mint-token.js --name <you>-laptop --user <you>              # member
docker compose exec hive node dist/cli/mint-token.js --name <you>-laptop --user <you> --role curator
```

- The token is kept **for this browser tab only**. Closing the tab signs you out; a new tab asks again.
- Your name and role are shown at the bottom of the menu. Click them to see which token you signed in with and to
  **Sign out**, which forgets the token.
- You can use the same token your Hermes plugin uses, or mint a separate one for the browser so it can be
  revoked on its own.

## Finding your way around

The menu runs down the left side. On a phone it sits behind the **Menu** button in the top bar.

| Menu item | Its pages (tabs along the top) | Who |
|---|---|---|
| **Knowledge** | [Facts](#facts), [Search](#search) | everyone |
| **Review** | New ([Review](#review-curators)), Out of date (facts nobody has used in a while) | curators |
| **Playbooks** | step-by-step instructions agents follow for a kind of task | curators |
| **Teams** | teams, their people and repos | curators |
| **Admin** | Sources ([Repos](#repos)), Usage and cost ([Stats](#stats-curators)), Notifications ([Settings](#settings-curators)) | everyone sees Sources; the rest is curators only |

A number next to **Review** is how many facts are waiting for a curator. The page addresses haven't changed
(`/facts`, `/review`, `/stale`, `/repos`, `/stats`, `/settings`), so old links and the daily digest's link still
work. The screenshots in this manual show the dashboard before the redesign; they are replaced as each page is
rebuilt.

## Words you'll see

The dashboard uses plain words. The word in brackets is the value the API and older screens use, shown here once
so you can match them up.

- **Fact**: one short statement the hive can tell an assistant, such as "The orchestrator gate waits for a person."
- **Kind**: what sort of fact it is: **Decision**, **Must stay true** (invariant), **Pitfall** (gotcha),
  **Preference**, **Convention** or **How it works** (system).
- **Who gets it** (scope): **Everyone** (global), **Repo:** and the repo name (`repo:<key>`), **Team:** and the team name, or
  **Just me** (personal), which only you see.
- **Status**:
  - **Waiting for review** (candidate): proposed, waiting for a curator; **not** given to assistants yet.
  - **Live** (active): approved, so assistants are given it.
  - **Replaced** (superseded): a newer fact took its place (kept as history).
  - **Retired** (retracted): withdrawn or rejected (kept as history).
- **Origin**: where it came from.
  - **Written by a person** (authored): someone wrote it, through Hermes or the API.
  - **Learned from a conversation** (distilled): the hive-worker proposed it from something a person said.
  - **Read from the repo** (ingested): taken from a repo's docs or code.
- **Where this comes from** (anchors): the evidence behind a fact, either a quote from a file at a line or a quote
  from a conversation. The hive re-checks file quotes and says whether the source **Still matches** (verified),
  **Source changed** (drifted), **Source gone** (missing), **Can't check from here** (unverifiable_here) or
  **Not checked yet** (unverified). See [anchor health](#anchor-health).

How a fact goes live:

- Facts for **Just me** are live at once.
- Shared facts written by a **curator** are live at once.
- Shared facts written by a **member**, and everything **learned from a conversation**, start as **Waiting for
  review** in [Review](#review-curators).

## Facts

![Facts page with a fact open](img/fact-detail.png)

Every fact agents are given, and where each one came from: everything you can see, newest first, 50 per page.
Dates read as "3 hours ago" or "Nov 7"; hover one for the full date and time.

**Filters** along the top narrow by who gets it, repo, status, origin and kind. The filters are kept in the page
address, so you can bookmark or share a filtered view. When nothing matches, the page says so and explains how
facts get here.

**Search** on this page finds facts by meaning, not just by matching words. Up to 100 matches, ranked by relevance,
and still narrowed by the filters. Facts waiting for review are included. For conversations, commits and docs, use
the [Search](#search) page.

**Click a row**, or move with `j`/`k` and press `Enter`, to open the fact on the right:

- Its kind, who gets it, status (with any note) and origin.
- **Where this comes from**: each piece of evidence with its quote and its [health badge](#anchor-health). A file
  quote links to the exact lines on GitHub, at the commit the hive last read (shown as its first 7 characters).
  If the quote has moved, it says where it is now.
- **Supersedes / Superseded by**: the chain of older and newer versions of this fact, each with its status. Click
  one to open it.
- **Reviews**: who approved, fixed or rejected it, when, and why.
- **Details** (closed until you click it): the fact's id, its author, the full time it was recorded, and the files
  or areas it is about (locus).

`Esc` closes the panel. The open fact is part of the page address, so a link opens straight to it.

## Search

![Search for "orchestrator gate"](img/search.png)

Search facts, docs, commits and past conversations at once. Type a question or a few words and press `Enter`.

**Sources** are the chips under the box. Click them to switch each one on or off:

- **Facts**: shown first, in their own section, with kind, who gets it and status.
- **Conversations**: single turns from your past Hermes sessions.
- **History**: your whole past Hermes sessions.

Conversations and History only ever show **your own** sessions, never a teammate's.
- **Commits**: commit messages, with the commit's first 7 characters and its subject.
- **Docs**: chunks of the repos' documents, linked to the file and lines on GitHub.

Each source returns its best 20 results. Results mix meaning (embeddings) with keywords, so an exact name or
error message works as well as a plain-English question. Facts show their status, so facts waiting for review are
easy to spot. Click a fact to open it on the Facts page.

## Repos

![Repos page](img/repos.png)

The repositories the hive reads. For each one:

- **Key and path**: e.g. `gh/bennybrau/agentic-software-factory` and where it's checked out on the hive's host.
- **Ingested … at `abc1234`**: when the hive last read it and at which commit. The hive always reads the
  repo's **default branch** as last fetched from origin, not whatever branch happens to be checked out. It
  re-reads every 15 minutes by default.
- **Counts**: documents, chunks (searchable pieces of documents) and commits indexed.
- **Last ingest failed: …**: appears only when the last read went wrong.

### Anchor health

The badges show how the hive's evidence in this repo holds up against the files as they are now:

- **verified**: the quote is still there (it may have moved; the fact panel says where).
- **drifted**: the quote isn't there word for word, but a close match is. The source was edited, and the
  fact may need updating.
- **missing**: the file is gone, or nothing like the quote is left. A fact read from docs is retracted
  automatically if this persists. A fact someone wrote is never retracted; it's left for a person to look at.
- **unverifiable here**: nothing this hive can check.
- **unverified**: not checked yet.

### Buttons

- **Files not indexed**: lists documents the hive considered but didn't index (empty, skipped or failed) and
  why. Use it when a doc you expected doesn't show up in Search.
- **Ingest now** (curators): read the repo right away instead of waiting for the next sync. It's disabled while a
  read is running. When done it shows a summary: docs indexed, unchanged and removed, new commits, and the result of
  re-checking every anchor.

Registering a new repo is done through the API (`POST /v1/repos`) for now, not in the dashboard.

## Review (curators)

![Review queue](img/review.png)

The queue of candidates, **oldest first**. Nothing here reaches anyone's assistant until you decide. The
candidate list is on the left and the evidence for the selected one is on the right:

- The fact's kind, scope and origin, and the fact it would **supersede**, if any.
- **Anchors**: the quote it was drawn from. For a distilled fact this is the passage of the conversation, with
  about 300 characters around it, so you can judge it in context.
- **Similar active facts**: up to 3 existing facts that say nearly the same thing, with a similarity
  percentage. If one already covers it, reject the candidate or fix it to match the existing fact.

### Deciding

| Key | Action |
|---|---|
| `j` / `↓`, `k` / `↑` | next / previous candidate |
| `a` | **approve**: the fact becomes active and assistants start recalling it |
| `f` | **fix**: edit the text, then `Enter` to save it as active (`Shift+Enter` for a new line, `Esc` cancels) |
| `r` | **reject**: optional reason, then `Enter` (`Esc` cancels) |

The **Approve**, **Fix…** and **Reject…** buttons under the fact do the same with a mouse or a finger.

- **On a phone** the queue shows one candidate at a time: the fact first, then the conversation it came from
  (a long bot reply is cut short; tap **Show all of it**). Use **‹ ›** to move between candidates. The decision
  buttons stay at the bottom of the screen while you scroll the card.
- **Undo**: every decision waits **5 seconds** before it is saved, with an **Undo** button. Making the next
  decision, or leaving the page, saves the previous one at once.
- **Fixing into an existing fact**: if your fixed text is word for word an existing fact in that scope, the
  candidate is **merged** into it. Its evidence moves to that fact and the candidate is closed.
- **Approving a superseding candidate** retires the fact it replaces.
- When the queue is empty, it tells you when the last distill ran. If that was long ago and people have been
  working, check the worker on [Stats](#stats-curators).
- If a decision can't be saved, the candidate comes back with the error.

## Stats (curators)

![Stats page](img/stats.png)

Pick a window of **7, 30 or 90 days**.

- **Cost**: model calls per job (`distill` = turning conversations into candidates, `embed` = making text
  searchable), with input/output tokens and estimated cost, in total and per day. With local embeddings (Ollama)
  `embed` is $0.
- **Facts**: how many facts there are by status, origin and scope, and how many were recorded each day.
- **Workers**: each hive-worker and when it last checked in. **stale** means it hasn't been seen for 10
  minutes, so conversations aren't being distilled.
- **Backlog**: candidates waiting for review and conversations waiting to be distilled, each with the age of the
  oldest. A growing distill backlog with a stale worker means the worker is down.

## Settings (curators)

**Daily review digest** is a short message, once a day, saying what is waiting in [Review](#review-curators),
with a link to it. It goes by email, Telegram or both, and it is built for the curator who last saved the settings.

1. Turn on **Send the daily digest** and pick the **time** and **time zone**.
2. **Dashboard link** is where the digest's links point. It starts as the address you're using now.
3. Turn on **Send by email**, **Send by Telegram** or both, and fill in the fields below.
4. **Save**, then **Send test**. Each channel shows ✓ **Sent** or ✗ **Failed** with the reason. The test
   doesn't count as the day's digest. Unsaved changes can't be tested: save first.

Passwords and bot tokens are never shown again. A saved one reads **saved**; leave it blank to keep it, or type a
new one to replace it. Turning a channel off and saving forgets its password or token. Below the buttons you
see when the last digest went out, how many items it had, and its last error.

**Telegram.** Message [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. It answers
with the **bot token** (like `123456:ABC-…`). Then find the **chat id**: send your new bot any message (or add it
to a group and post there), open `https://api.telegram.org/bot<token>/getUpdates` in a browser, and copy
`"chat":{"id": …}`. A group's id starts with `-`.

**Gmail.** Use host `smtp.gmail.com`, port `465`, **Secure connection** on, your Gmail address as the user, and an
**app password** (Google Account, Security, 2-Step Verification, App passwords) rather than your normal one.
Gmail refuses the normal password.

## Keyboard shortcuts

| Where | Key | Does |
|---|---|---|
| Facts | `j` / `k` (or arrows) | move through the table |
| Facts | `Enter` | open the selected fact |
| Facts | `Esc` | close the fact panel |
| Review | `j` / `k` (or arrows) | move through candidates |
| Review | `a` / `f` / `r` | approve / fix / reject |
| Review, editing | `Enter` / `Shift+Enter` / `Esc` | save / new line / cancel |

Shortcuts are ignored while you're typing in a box.

## Troubleshooting

- **"The hive didn't accept that token."**: the token was revoked or mistyped. Ask for a new one.
- **"Couldn't reach the hive."**: the hive is down, or you're off the tailnet.
- **Review, Playbooks and Teams are missing from the menu, and Admin only has Sources**: your token is a member token.
- **A doc you expected isn't in Search**: open Repos → **Files not indexed**. Check that the change is on the
  repo's default branch and was fetched from origin.
- **No new candidates after a session**: check Stats → Workers (stale?) and Backlog.
