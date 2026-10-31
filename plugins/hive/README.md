# Hermes memory provider: `hive`

Connects a Hermes instance to the team's Hive. Stdlib only, no new dependencies for Hermes.

## What it does

| When | What | Cost |
|---|---|---|
| Before each turn (`prefetch`) | `GET /v1/recall` with your message, the current repo, and a strict relevance gate; injects at most 5 facts as `[hive:<id>]` lines | ~30 ms, no LLM |
| After each turn (`sync_turn`) | records the turn as an episode (Hermes redacts secrets first and runs this off the response path) | one HTTP POST |
| Session end | records the whole transcript (tool output clipped) as a `session` episode, input for distill in M4 | one HTTP POST |
| Tools | `hive_recall` (facts), `hive_search` (facts, your conversations, repo docs + commits), `hive_remember`, `hive_retract`, `hive_status` | only when the model calls them |

Prefetch and `hive_recall` also send the files you've changed (`git status`, at most 200) so facts located
there rank higher, and a fact whose source was edited or deleted is marked "source changed since" / "source gone".

Token rules for prefetch, because Hermes replays the injected block on every later request of the session:
- a fact is injected **once per session**; later turns only add new ones (`/new` resets, `/branch` and compression inherit);
- a fact is injected only if its meaning similarity to the message is ≥ `HIVE_PREFETCH_MIN_SIM` (0.62), so
  keyword-only coincidences and off-topic messages inject nothing;
- explicit `hive_recall` calls are not gated.

Subagents, cron jobs and memory flushes read but never write.

The repo comes from `git remote get-url origin` in the session's directory (`github.com/o/r` → `gh/o/r`);
`hive_remember` defaults to that repo's scope, or `global` outside a repo. Shared facts from members are
**candidates** until the curator approves them; personal facts are only ever visible to you.

## Install (any machine running Hermes)

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
`HIVE_REPO_KEY` (override the detected repo), `HIVE_SYNC=off` (don't record turns/sessions).

Activating it replaces any other external provider you have on. Built-in MEMORY.md/USER.md keep working.

## Tests

```bash
scripts/test-plugin.sh   # unit: Hermes' real MemoryProvider code + a recording fake hive
scripts/e2e-plugin.sh    # live: a real `hermes -z` session in a throwaway profile against the running hive
```
