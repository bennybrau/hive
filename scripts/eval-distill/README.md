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

Seven of the 15 session cases should produce nothing: chit-chat, status checks, routine work and a code review.

Three more cases, `bot-*`, are synthetic: written in the same format to check that facts come from what the person
said. In two the assistant proposes or summarises and the user only says ok or thanks (nothing to keep); in one the
user corrects the assistant's proposal (the correction is the fact).

Before committing a new case, run `python3 extract.py scan cases/*.txt`, which must exit 0. Replace any hit with
`[REDACTED]` and any third-party email address with `[EMAIL]`.

**Labelling bar:**
- **Durable:** still true after the session.
- **Useful weeks later.**
- **Not readable from the code.**
- **Settled:** the user decided it, or the session proved it.

Status, logs, findings about the diff under review, and assistant proposals the user didn't take up are not facts.
