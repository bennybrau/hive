# Distill eval

Labelled transcripts for measuring `apps/worker/prompts/distill.md`, and the one command that scores it:

    scripts/eval-distill.sh [--only id,id] [--repeat N] [--concurrency N]

It builds the hive-worker image and runs the worker's own distill (same runner, chunking, parsing and quote repair as
a real job) over every case, inside the container. The prompt directory is mounted, so prompt edits need no rebuild.
It needs `CLAUDE_CODE_OAUTH_TOKEN` (or `CLAUDE_OAUTH_TOKEN`) in the environment. A full run costs about $1.40 on the
subscription: $1.15 for distill and $0.25 for the judge. It exits 0 when every target passes. A JSON copy of each run
goes to `results/` (git-ignored).

**Targets** (from #11):
- at least 75% of expected facts found;
- at most 1 false positive per 5 sessions;
- 0 invalid quotes.

**Matching.** A claude judge (`HIVE_EVAL_JUDGE_MODEL`) maps each proposed fact to the label stating the same claim,
or to none. Pairing, duplicates and the bar are pure code (`apps/worker/src/eval/score.ts`, unit-tested). Embedding
similarity was tried first and dropped: on nomic-embed-text, true restatements scored 0.80–0.84 and an unrelated fact
0.81, so no threshold separated them.

## Cases

`cases/<id>.txt` is a window of one of Jon's real Hermes sessions, rendered exactly as the plugin posts it:

    python3 extract.py render <session> <lo> <hi>

Each window is at most 45k characters, so it fits one chunk. `cases/<id>.json` holds the labels:
- **`expected`:** facts a curator would accept. They count toward recall.
- **`acceptable`:** borderline facts. Proposing one is neither credited nor a false positive.
- **`evidence`:** a verbatim passage for each label.
- **`repo_key`:** the repo the session ran in.
- **`related`:** optional, the active facts a claim would send with the episode (`{id, text, kind, scope}`); a label's
  **`replaces`** names the one it corrects, and a unit test checks it is listed.
- **`source`:** where the transcript came from: `{"session", "lo", "hi"}` for a window of a real session,
  `{"cut_from": "<case>", "lines": [lo, hi]}` for lines cut (inclusive) from another case's transcript,
  `{"episode": "<ref>"}` for an `asf_dialog` episode copied from the Hive as stored, or
  `{"synthetic": "..."}` for a written one, whose `notes` then start with SYNTHETIC.

Nine of the 12 session cases should produce nothing: chit-chat, status checks, routine work, and
sessions whose only facts the assistant found or proved without the user stating them.

Three other real windows (`asf-open-source`, `asf-tailscale`, `asf-review-findings`) were removed before the
repository went public because they held private names and addresses. Results recorded before then, here and in
`docs/`, were scored with them included.

Three more cases, `bot-*`, are synthetic: written in the same format to check that facts come from what the person
said. In two the assistant proposes or summarises and the user only says ok or thanks (nothing to keep); in one the
user corrects the assistant's proposal (the correction is the fact).

Six cases check distill-v6's shape rule and don't-save list. Five `excl-*` cases expect nothing, even though the user
says each thing: `excl-setup-failure` (cut from `asf-uninstall`), and the synthetic `excl-transient`, `excl-one-off`,
`excl-tool-broken` and `excl-failed-attempts`. In the synthetic `story-rule` the user tells an incident with a PR
number and a date and ends with a rule; the one expected fact is the bare rule and its reason.

Seven `dialog-*` cases (distill-v8) are real `asf_dialog` episodes, copied verbatim from the Hive (`source:
{"episode": "<ref>"}`). Four expect nothing: the person approves the factory's plan or defaults, or tells it what to do
in this pull request (`dialog-defaults-ok`, `dialog-plan-matches`, `dialog-split-version`, `dialog-who-runs-eval`);
the curator rejected every candidate they produced under distill-v7. Three keep product decisions a teammate would act
on (`dialog-avatars`, `dialog-activity-name`, and `dialog-commit-types`, whose two "yes" answers are acceptable).

One case checks distill-v7's `replaces`: in the synthetic `corr-replaces-fact` the user corrects a fact the hive already
has (in its `related`), and the expected fact replaces it. The `replaces-miss` column counts found facts whose
`replaces` differs from their label's; it is reported, not part of the targets.

Before committing a new case, run `python3 extract.py scan cases/*.txt`, which must exit 0. Replace any hit with
`[REDACTED]` and any third-party email address with `[EMAIL]`.

**Labelling bar:**
- **Durable:** still true after the session.
- **Useful weeks later.**
- **Not readable from the code.**
- **Settled:** the user decided, corrected or clarified it in a `user:` turn (the label's evidence quotes that turn).
  Something the session proved but the user never said is acceptable at most.
- **A rule, not a story:** a standalone rule a teammate can act on, plus the person's reason when given. No PR/issue
  numbers, dates, run ids or narration in the text (they stay in the evidence); a unit test rejects `#123` and ISO
  dates in expected labels. The same decision said twice is one label.

Status, logs, findings about the diff under review, and assistant proposals the user didn't take up are not facts.
Nor, even when the user says them: setup or environment failures (a missing binary or file, credentials, fresh-install
errors), "tool or feature X is broken", transient errors that were resolved, one-off task details, and attempts that
didn't work. If a setup step fixed something, the fix is acceptable at most, never the failure.
