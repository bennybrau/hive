# Hermes memory provider: `hive`

Connects a Hermes instance to the team's Hive. Stdlib only, no new dependencies for Hermes.

Joining someone else's Hive? Start with [docs/JOINING.md](../../docs/JOINING.md): what is sent, who sees it, and
how to turn it down or off.

## What it does

| When | What | Cost |
|---|---|---|
| First turn of a session in a repo (`prefetch`) | `POST /v1/brief` with your message as the task, the repo and your changed files; injects a compact brief (playbook, gotchas, facts as `[hive:<id>]` lines, where to look, past runs, tests; ~600 tokens) instead of recall. Asked once per session (`/new` asks again); if it fails, that turn uses recall | one HTTP POST, no LLM |
| Before each turn (`prefetch`) | `GET /v1/recall` with your message, the current repo, and a strict relevance gate; injects at most 5 facts as `[hive:<id>]` lines | ~30 ms, no LLM |
| After each turn (`sync_turn`) | records the turn as an episode (Hermes redacts secrets first and runs this off the response path) | one HTTP POST |
| Session end | records the whole transcript (tool output clipped to 1,500 chars per call) as a `session` episode, which distill reads to propose facts | one HTTP POST |
| Tools | see below | only when the model calls them |

| Tool | Who | What |
|---|---|---|
| `hive_recall` | everyone | active facts for a question, with full ids |
| `hive_search` | everyone | facts, your conversations, repo docs + commits |
| `hive_remember` | everyone | save a fact; `supersedes: <full id>` when it corrects a fact you were shown |
| `hive_retract` | author or curator | mark a fact wrong |
| `hive_status` | everyone | who this instance is, counts, embedding health |
| `hive_review` | curators only | `list` the candidate queue, then `approve`, `fix` (with `new_text`) or `reject` one by full id |

Prefetch and `hive_recall` also send the files you've changed (`git status`, at most 200) so facts located
there rank higher, and a fact whose source was edited or deleted is marked "source changed since" / "source gone".

`hive_recall` and `hive_search` take an optional `also_repos` (up to 3 repo keys, e.g. `gh/acme/lib`) to read other
repos too when a task spans them; keys the Hive doesn't know come back in `unknown_repos`. The first-turn brief
reads the current repo only.

Token rules for prefetch, because Hermes replays the injected block on every later request of the session:
- a fact is injected **once per session**; later turns only add new ones (`/new` resets, `/branch` and compression inherit);
- a fact is injected only if its meaning similarity to the message is ≥ `HIVE_PREFETCH_MIN_SIM` (0.62), so
  keyword-only coincidences and off-topic messages inject nothing;
- explicit `hive_recall` calls are not gated.

"Remember this" turns: when your message asks the assistant to remember something ("remember this",
"don't forget", "add this to your memory", "note that", "keep in mind", "from now on", "going forward",
"for future reference", …), the turn is sent with `metadata.remember_request: true` and the assistant's
previous reply (last 4000 chars) as an extra `assistant:` line before it, so "this" can be resolved. Quoted
text, code and blockquotes don't count, nor do questions ("do you remember…", "remember when…?") and
negations ("I don't remember").

Subagents, cron jobs and memory flushes read but never write.

The repo comes from `git remote get-url origin` in the session's directory (`github.com/o/r` → `gh/o/r`).
That is the directory the session was started in, also when a gateway serves it (Hermes' own session
directory, not the gateway process's);
`hive_remember` defaults to that repo's scope, or `global` outside a repo. Shared facts from members are
**candidates** until the curator approves them; personal facts are only ever visible to you.
`scope=team` writes into your team (pass `team: <key>` if you're in more than one). Facts are labelled by level:
`personal`, `repo`, `team: <name> (your team|other team)` or `organisation`.

Review flow: the plugin asks `GET /v1/status` once (again later only if that call failed) and offers `hive_review` only when the token's
role is `curator` (if the hive can't be reached, the tool isn't offered; the server refuses non-curators anyway).
`hive_review action=list` shows up to 20 candidates, oldest first: full id and `id8`, text, kind, scope, the
`id8` of the fact it would supersede, and very similar active facts as `"[id8] text (0.91)"`. Approving a
candidate that supersedes a fact replaces that fact; a `fix` whose text already exists is merged into that fact.

## Install (any machine running Hermes)

One line does all of it: it downloads the plugin matching the Hive's version, writes `HIVE_URL` and `HIVE_TOKEN`
into `~/.hermes/.env` and makes `hive` the memory provider (see [docs/INSTALL.md](../../docs/INSTALL.md#join)):

```bash
curl -fsSL https://raw.githubusercontent.com/bennybrau/hive/main/scripts/install.sh | bash -s -- join --url http://<hive-host>:8800 --token hive_...
```

From a checkout, by hand:

```bash
# 1. make the plugin visible to Hermes (directory name = provider name)
ln -s ~/dev/hive/plugins/hive ~/.hermes/plugins/hive

# 2. URL and a token minted by the hive (scripts/setup.sh or mint-token), in ~/.hermes/.env:
HIVE_URL=http://<hive-host>:8800
HIVE_TOKEN=hive_...

# 3. activate it (only one external memory provider can be active)
hermes config set memory.provider hive     # or: hermes memory setup
hermes memory status
```

Optional: `HIVE_PREFETCH_K` (default 5, `0` = no automatic injection), `HIVE_PREFETCH_MIN_SIM` (0.62),
`HIVE_REPO_KEY` (override the detected repo), `HIVE_SYNC=off` (don't record turns/sessions; explicit
`hive_remember` still saves),
`HIVE_BRIEF=off` (no first-turn brief; `HIVE_PREFETCH_K=0` doesn't turn it off).

Activating it replaces any other external provider you have on. Built-in MEMORY.md/USER.md keep working.

## Tests

```bash
scripts/test-plugin.sh   # unit: Hermes' real MemoryProvider code + a recording fake hive
scripts/e2e-plugin.sh    # live: a real `hermes -z` session in a throwaway profile against the running hive
```
