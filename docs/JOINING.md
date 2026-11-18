# Joining a Hive

This page is for a teammate connecting their own Hermes to a Hive someone else runs. It covers how to join, what
your Hermes sends, who can see it, and how to turn it down or off. It describes the current code; where something
is not built yet, it says so.

**Words used here.** A **fact** is one short statement meant to stay useful for weeks ("the reporting service uses
Postgres because it needs joins"). An **episode** is a raw record of something that happened: one turn of a chat,
or a whole session. The **curator** is the person who approves facts before they are shared; the person who runs
the Hive gives you a **token**, which says who you are.

## 1. Join

You need Hermes on your machine and a token from whoever runs the Hive. Docker is not needed on your side.

```bash
read -rs HIVE_TOKEN && export HIVE_TOKEN    # paste the token, then Enter (it isn't echoed)
curl -fsSL https://raw.githubusercontent.com/bennybrau/hive/main/scripts/install.sh \
  | bash -s -- join --url http://<hive-host>:8800
```

Reading the token into `HIVE_TOKEN` keeps it out of your shell history (`--token <t>` works too). `join` checks the Hive answers and
accepts the token, downloads the plugin that matches the Hive's version, writes `HIVE_URL` and `HIVE_TOKEN` into
`~/.hermes/.env` (mode 600), and makes `hive` your Hermes memory provider. Details and flags:
[INSTALL.md](INSTALL.md#join).

If `join` stops with `no plugin download for Hive version 'dev'`, the Hive was built from source rather than a
release. Ask whoever runs it which version to use and add `--version <v>` (a release such as `0.2.0`).

Hermes has one external memory provider at a time, so this replaces any other one you had on. Hermes's own
MEMORY.md and USER.md keep working.

Check it worked: start Hermes in one of your repos and ask it to run `hive_status`.

## 2. What your Hermes sends

| When | What is sent | Turned off by |
|---|---|---|
| Before each message | Your message, the repo you are in (from `git remote get-url origin`) and the paths of files you have changed (`git status`, at most 200 paths, not their contents), to find facts that fit | `HIVE_PREFETCH_K=0` |
| First message of a session in a repo | The same, to fetch a short briefing for the task | `HIVE_BRIEF=off` |
| After each turn | Your message and the reply, as a `turn` episode, with the repo name | `HIVE_SYNC=off` |
| End of a session | The whole conversation as a `session` episode. Tool output is clipped to 1,500 characters per call (your answers to Hermes's questions to 8,000) | `HIVE_SYNC=off` |
| When you or Hermes call a Hive tool | What that tool needs: a question, or the text of a fact to save | don't call it |

**Secrets are scrubbed first.** Hermes removes secrets (API keys, tokens and similar) from everything it hands a
memory provider, before the plugin sees it. That is Hermes's own scrubber; it catches the usual shapes, not
everything, so don't paste a credential into a chat you would not want stored.

**Not sent:** file contents (only changed paths), your Hermes config, your `.env`, and anything from subagents,
cron jobs or background memory flushes (those read from the Hive but never write).

**What happens to it on the Hive.** Episodes are stored in the Hive's database. A background job reads sessions
and turns to propose facts. It skips sessions where you only asked questions. To do this it sends the episode
text to Claude (Anthropic) on the account of whoever runs the Hive, and every such call is logged with its cost.
Nothing is deleted: there is no way to delete an episode through the Hive today. Ask the person running the Hive
if you need one removed.

## 3. Who can see what

Facts have a **level**:

- **Just me** (personal): only you. Nobody else, curators included, is ever shown your personal facts.
- **Repo**, **Team** and **Everyone** (organisation): shared. Any connected Hermes can read them; a team is
  where its members' Hermes looks first, not a wall.

How a fact gets in:

- **You save it** (`hive_remember`, or tell Hermes "remember that…"). A personal fact is active at once. A shared
  one is a **candidate** until the curator approves it, so one mistake doesn't reach everyone.
- **The Hive proposes it** from your conversations. It is a candidate. A shared one goes to the curator's review
  queue. Only what a person said that a bot would otherwise get wrong (a correction, a decision, an explicit
  "remember this") is meant to be proposed.
- A proposed **personal** fact is not shown to the curator (nobody sees your personal facts), and approving one
  yourself isn't built yet, so for now it simply stays unused.
- Candidates are never handed to Hermes automatically, and recall never returns them; `hive_search` lists shared
  candidates only when asked to include them.

Who can see your conversations:

- `hive_search` shows your own turns and sessions to you only. It never returns another person's conversation.
- The curator sees a short quote from the conversation that a proposed fact came from, on the review page, so
  they can judge it.
- Whoever runs the Hive can read its database, which holds the full episodes. Treat a Hive like any shared team
  server.

## 4. Taking back a fact

- `hive_retract` marks a fact wrong. You can retract facts you wrote and facts the Hive learned from your
  conversations; the curator can retract any fact. Retracted facts stay as history (marked wrong), they are not
  deleted, and they are no longer handed to anyone.
- To correct one instead, save the right version with `hive_remember` and `supersedes: <the old fact's full id>`.

## 5. Turning it down or off

Put these in `~/.hermes/.env` (or your profile's `.env`); they apply from the next session.

| Setting | Effect |
|---|---|
| `HIVE_SYNC=off` | Nothing you say is sent any more: no turns, no sessions. Recall, the briefing and the tools still work, and a fact you explicitly save with `hive_remember` is still saved. |
| `HIVE_PREFETCH_K=0` | Hermes is no longer handed facts automatically before each message. |
| `HIVE_BRIEF=off` | No briefing on the first message of a session. Independent of `HIVE_PREFETCH_K`. |
| `HIVE_REPO_KEY=<key>` | Use this repo key instead of the one detected from your git remote. |

**All the way off:**

```bash
hermes config set memory.provider ''
```

Hermes then stops calling the Hive at all. To cut the connection from the Hive's side too, ask the curator to
revoke your token (dashboard: Admin → Tokens); the token stops working on its next call, and what you sent before
stays.

## 6. The dashboard

Open the Hive's address in a browser and sign in with your token. Everyone can browse and search facts; the
review queue, tokens, teams and settings pages are for curators. The page-by-page guide is
[manual/README.md](manual/README.md).
