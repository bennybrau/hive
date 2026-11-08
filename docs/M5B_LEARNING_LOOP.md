# M5b — Learn like Hermes: cheaper, cleaner learning

Status: **IN PROGRESS** — milestone https://github.com/bennybrau/hive/milestone/8. WP1 (#73) and WP3 (#75) done; WP2 dropped; WP1b (#85) added.

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
(the `supersedes` chain from M4). Same prompt version as WP3 (do WP3 first).

*Checkpoint:* **WP5 — Re-run the experiment (#77)** after WP1, WP1b, WP3 and WP4. Same questions, seed and arms; compare with the
baseline. Also report the Hive's real-world spend over the week before (`report.py --since`), since the experiment's
sessions are all question-only. Bar: net ≥ $0, on-arm accuracy ≥ 85%.

**WP6 — Playbooks (how-to, not just facts) (#78).** A `playbook` is a short procedure for a class of task in a repo:
when it applies (paths, task words), the steps, and the pitfalls, each step linked to the facts it came from.
The curator creates and edits them in the dashboard; distill can propose "add this step to playbook X" from a
person's correction; the brief includes a matching playbook. Spike the shape on ASF's real corrections first (do
enough of them group into procedures?).

**WP7 — Use counts and retirement (#79).** Count each fact's real use: brief/recall injections and `[hive:<id>]`
citations in answers. A fact unused for `HIVE_STALE_DAYS` (default 60) is marked stale and listed on a dashboard
*Stale* tab for the curator to keep, fix or retire; nothing is retired automatically. A fact cited in an answer a
person then corrects goes back to the review queue with the correction attached.

**WP8 — Final re-run (#80).** After WP6 and WP7, re-run the experiment and update [the results](EXPERIMENT_RESULTS.md) and
the explainer.

## Order

WP1 → WP1b (cost) and WP3 → WP4 (quality) can run in parallel; WP5 needs all four. WP6 and WP7 are independent of
each other and start after WP5; WP8 last. WP6 starts with a spike.
