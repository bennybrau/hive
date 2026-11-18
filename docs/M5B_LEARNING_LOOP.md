# M5b — Learn like Hermes: cheaper, cleaner learning

Status: **DONE (2026-11-17)** — milestone https://github.com/bennybrau/hive/milestone/8. All WPs done except WP2 (dropped) and WP6d–e (held in bennybrau/hive#10). Final reading and decision: [EXPERIMENT_RESULTS.md § Re-run after M5b](EXPERIMENT_RESULTS.md#re-run-after-m5b-final-2026-11-17).

**Scope rule:** Hermes is not changed. M5b takes ideas from how Hermes self-improves and applies them inside Hive only.

## Why

The M5 experiment ([results](EXPERIMENT_RESULTS.md)) showed the Hive makes answers cheaper and more often right, but
spends more than it saves: 48 distills at $0.038 each, nearly all finding nothing, against $0.019 saved per question.
Hermes learns from its own conversations too (memory and skills) at a fraction of that, so this milestone does two
things: stop paying for reads that can't produce a fact, and adopt the parts of Hermes's self-improvement that make
what's learned cleaner and more useful. It ends by re-running the experiment.

## How Hermes self-improves (verified in the Hermes source, `66605471e9f`)

- **When:** a counter, not the content. A memory review every `memory.nudge_interval` user turns (default 10); a skill
  review after `skills.creation_nudge_interval` tool-calling iterations without a skill edit (default 10). Never on
  cron, interrupted or empty turns (`agent/turn_finalizer.py`, `agent/turn_context.py`).
- **What:** after the reply is delivered, a background fork gets the whole conversation plus a review prompt
  (`agent/background_review.py`). It runs on the session's model (or `auxiliary.background_review.{provider,model}`)
  and reads the conversation mostly as cached tokens, which makes it cheap.
- **Signals the prompt looks for:** the user correcting style, format, approach or sequence; frustration; an explicit
  "remember this"; a reusable technique; a loaded skill that turned out wrong.
- **Where it writes:** patch the skill in use first, then an existing umbrella, then a `references/` file, and only then
  a new class-level skill. Facts about the user go to `USER.md`, about the environment to `MEMORY.md`.
- **Shape rules:** procedure first; a pitfall is a rule plus why; no PR numbers, dates or narration as content; the
  same lesson twice is one rule; fix in place, never "UPDATE: actually…".
- **Never save:** environment/setup failures, "tool X is broken" claims (they harden into refusals), transient errors,
  one-off task narratives, unresolved failures presented as a method.
- **Lifecycle:** the curator tracks per-skill use, marks idle agent-made skills stale and archives them; never deletes.
- **Why WP2 was dropped:** the review fork runs with `skip_memory=True` (`_fork_init_kwargs`), so its memory writes are
  **not** mirrored to an external memory provider today. Foreground memory-tool writes are mirrored
  (`MemoryManager.notify_memory_tool_write` → provider `on_memory_write(action, target, content, metadata)`, with
  `metadata.write_origin`). The metadata already has a `background_review` origin, but nothing forwards the fork's
  writes.

## Decisions

1. Keep the human rule from M5: a fact must quote what a person said. Nothing here relaxes it.
2. Cut the cost first (WP1, WP1b), measure, then improve quality (WP3–WP6), measure again.
3. Hermes is not modified. Hive borrows its ideas (skip what can't teach anything, short rules, fix in place, a don't-save list, use counts) and implements them in the hive and its plugin.
4. Don't copy Hermes's counter trigger (it fires regardless of content) or its "a pass that does nothing is a miss"
   bias (fine for a private skill library, floods a shared review queue).

## Work packages

**WP1 — Skip question-only sessions; send only what may be quoted (#73).** A `session` whose user turns are all plain
questions finishes with no model call. For the rest, the distiller gets the user turns, clarify answers and the
assistant message before each one, not tool output. Expected: most distill calls disappear; the rest read a fraction
of the text.

**WP1b — Lean distill calls (#85).** Found in WP1's live check: after the view trims the episode, a distill still costs ~3¢ because `claude -p` loads Claude Code's default system prompt and tool definitions (~16,800 tokens) on every call. Running it with no tools, no settings or MCP, and a one-line system prompt measured $0.0095 instead of $0.0285 on the same input.

~~**WP2 — Hermes's review as the trigger (#74).**~~ Dropped (2026-11-07): it needed an upstream Hermes change (the review fork's memory writes don't reach memory providers), and Hermes stays unchanged.

**WP3 — Rules, not stories; a don't-save list (distill-v6) (#75).** Port Hermes's shape and do-not-capture rules into the
distill prompt: a fact is a standalone rule (plus why when the person gave it), with no PR numbers, dates or narration
as content; never save setup failures, "X is broken" claims, transient errors, one-off task details or unresolved
attempts. New eval cases for each excluded kind.

**WP4 — Corrections replace facts (#76).** When a person's words contradict or update an existing fact, the candidate says
"replaces fact X" instead of adding a twin. Hive sends the distiller the closest active facts in the episode's scope;
the distiller may return `replaces: <id>`; the review queue shows old vs new; approving supersedes the old fact
(the `supersedes` chain from M4). Prompt version `distill-v7` (after WP3's v6).

*Checkpoint:* **WP5 — Re-run the experiment (#77)** after WP1, WP1b, WP3 and WP4. Same questions, seed and arms; compare with the
baseline. Also report the Hive's real-world spend over the week before (`report.py --since`), since the experiment's
sessions are all question-only. Bar: net ≥ $0, on-arm accuracy ≥ 85%.

**WP6 — Playbooks (how-to, not just facts) (#78).** A `playbook` is a short procedure for a class of task in a repo:
when it applies (paths, task words), the steps, and the pitfalls, each step linked to the facts it came from.
The curator creates and edits them in the dashboard; distill can propose "add this step to playbook X" from a
person's correction; the brief includes a matching playbook. Spike the shape on ASF's real corrections first (do
enough of them group into procedures?).

*WP6 spike (2026-11-08):* the maintainer exported the active facts that came from conversations, read-only:

```sql
select f.id, f.scope, f.kind, f.locus, left(f.text, 300) as text, e.kind as ep_kind, e.repo_key
from facts f join anchors a on a.fact_id = f.id join episodes e on e.id = a.episode_id
where f.status = 'active' and e.kind in ('asf_dialog','session')
group by f.id, e.kind, e.repo_key order by f.scope, f.recorded_at;
```

59 facts. All 59 come from `asf_dialog` episodes and 0 from `session` episodes. 53 are in ASF and 6 in hive. By kind:
53 decision, 3 convention, 2 gotcha, 1 preference. Each fact was put in a group by repo and task class, using only its
text. A fact counts as procedural only if it is clearly a step or a pitfall for doing that kind of task; anything else
(mostly "the product should do X") does not. Ids below are the first 8 characters of the fact id.

| Group | Facts | Procedural |
|---|---|---|
| hive: writing an e2e acceptance script | 5 | 5 |
| hive: distill duplicate matching | 1 | 0 |
| ASF: changing registry Postgres code | 2 | 2 |
| ASF: Orchestrator / planner chat | 9 | 0 |
| ASF: Things to do and dependencies | 9 | 0 |
| ASF: releases, versions and updates | 7 | 0 |
| ASF: setup, workers and credentials | 6 | 0 |
| ASF: web UI navigation and layout | 5 | 0 |
| ASF: runtimes and the setup questionnaire | 4 | 0 |
| ASF: PR/MR review | 3 | 0 |
| ASF: skills | 3 | 0 |
| ASF: run retry | 2 | 0 |
| ASF: avatars | 2 | 0 |
| ASF: writing docs | 1 | 1 |
| **Total** | **59** | **8** |

Two groups have ≥ 2 procedural facts (steps and pitfalls both count). As playbooks:

**Playbook: hive, writing an e2e acceptance script.** Applies when: `scripts/e2e-*.sh`; task words *e2e*, *acceptance*,
*probe*. Steps:
1. Run the Hive side (service, Postgres, hive-worker) in containers; run Hermes on the host with throwaway profiles. (9d1160a7)
2. Create the script's own Hermes profiles and tokens. (4143622b)
3. Approve facts through the review API with a curator token, not the browser; a `--manual` flag pauses for a real click. (50e80343)
4. Read cost from `/v1/stats` for this run's distill, not the total. (c9d8257a)
5. On exit, delete the probe episode, facts, job and Hermes profiles and revoke the tokens, but keep the cost record. (c9d8257a, 4143622b)
6. Leave the numbers that need real credentials (timings, cost) blank; the maintainer runs it on the host before merge and adds them to the PR. (801dc93c)

**Playbook: ASF, changing registry Postgres code.** Applies when: `apps/registry/src/**`; task words *query*, *column*,
*Postgres*, *DB test*. Pitfalls:
1. The client maps columns to camelCase (`transform` in `pool.ts`); read results as camelCase, since snake_case fields are silently undefined. (b47b2cd0)
2. Postgres-backed tests are skipped on the worker, which has no database; a worker pass does not verify them, so run them against real Postgres. (6fc0da11)

Finding: the ASF dialog mostly produces product decisions (what to build), not procedures (how to do a kind of task):
53 of 59 facts are decisions, and only 8 are procedural.

Decision: go. Group 2 is thin (two pitfalls); if only steps counted, just group 1 would qualify.

**WP7 — Use counts and retirement (#79).** Done (2026-11-08). Count each fact's real use: brief/recall injections and `[hive:<id>]`
citations in answers. A fact unused for `HIVE_STALE_DAYS` (default 60) is marked stale and listed on a dashboard
*Stale* tab for the curator to keep, fix or retire; nothing is retired automatically. A fact cited in an answer a
person then corrects goes back to the review queue with the correction attached.

**WP8 — Final re-run (#80).** Done (2026-11-17): decision continue to M6, see the results. After WP6 and WP7, re-run the experiment and update [the results](EXPERIMENT_RESULTS.md) and
the explainer.

## Order

WP1 → WP1b (cost) and WP3 → WP4 (quality) can run in parallel; WP5 needs all four. WP6 and WP7 are independent of
each other and start after WP5; WP8 last. WP6 starts with a spike.
