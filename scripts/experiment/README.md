# M5 experiment

Does the Hive make Hermes cheaper at answering questions about ASF, without making it wrong? `questions.json` holds
16 questions with an answer key (#19). The runner asks each one with the Hive memory provider off and on, grades
every answer against its key, and prints the comparison:

    scripts/experiment/run.sh [--only id,id] [--repeats N] [--seed S] [--out DIR]
    python3 scripts/experiment/report.py DIR [--since TIMESTAMP]

**Run it on the Hermes host.** It needs the stack running (`scripts/redeploy.sh`) with the hive-worker, `hermes` on
PATH, an ASF checkout at `ASF_DIR` (default `~/dev/agentic-software-factory`) and `CLAUDE_CODE_OAUTH_TOKEN` for the
judge. Both arms are throwaway profiles cloned from your default Hermes profile, so they use the same model, and both
run in `ASF_DIR`:
- **`hive-exp-off`:** no memory provider, no hive plugin, no `HIVE_*` env. The run checks that `memory status`
  shows no hive.
- **`hive-exp-on`:** the hive plugin with a member token minted for the run.

The question × arm × run list is shuffled with `--seed`, which is saved in `DIR/seed` so an order can be replayed.
Each run is one fresh `hermes -z "<question>" --usage-file`. The script aborts if a run reports a different model.
Afterwards it:
1. waits for the on-arm's distill jobs (`EXP_DISTILL_TIMEOUT`, default 600 s);
2. dumps every `llm_calls` row from the run window to `llm_calls.csv`;
3. deletes the run's episodes, jobs and facts, and revokes the token. `llm_calls` rows are kept;
4. runs the judge and writes `results.csv`, then prints the report.

**Judge.** `apps/worker/src/experiment/judge.ts` runs in the hive-worker image with `claude -p` on the subscription
token. Its model is pinned by `HIVE_EXPERIMENT_JUDGE_MODEL` (default `claude-sonnet-5-5`). The judge never sees the
arm. An answer is correct when it states every key point and nothing in it contradicts them. For a `none` question,
the answer must say the thing doesn't exist. A malformed judge reply or a failed judge call counts as incorrect.
Per-point verdicts, notes and the judge's own cost go to `judge.jsonl`. The judge's cost is not counted in either
arm.

**Cost.** Everything is billed to your subscriptions. The full run (16 × 2 arms × 3 = 96 Hermes sessions) is #22.
The off arm explores the code, so it costs the most per session. The on arm also pays for a distill of each
session, which shows up as Hive spend. The judge makes one short claude call per answer. To check the setup first,
run a small subset: `--only who-1,why-1,none-1 --repeats 1` is 6 sessions.

## Output (`DIR`, default `results/<utc-ts>/`, git-ignored)

| file | what |
|---|---|
| `results.csv` | one row per run (below) |
| `llm_calls.csv` | the Hive's own model calls in the run window: distills of the on-arm sessions, briefs |
| `judge.jsonl` | the judge's per-point verdicts, contradictions, notes and cost |
| `plan.tsv`, `seed` | the shuffled run order and its seed |
| `runs/<id>.<arm>.<run>.answer.txt` / `.usage.json` | each answer and Hermes' usage file |

`results.csv` columns:
- `question`, `arm` (`off`/`on`), `run`, `model`;
- `api_calls`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `est_cost_usd`: as
  reported in Hermes' usage file (`estimated_cost_usd`);
- `correct`: the judge's verdict (1/0);
- `judge_notes`: the judge's notes, the missing key points (`K2`) and any contradictions;
- `manual`: empty. Fill in 1/0 (or y/n) to override `correct` after reading an answer;
- `cited_fact_ids`: the `[hive:xxxxxxxx]` ids cited in the answer, separated by spaces.

## Report

`report.py DIR` prints the following for each question and each `where` group, per arm: runs, mean tokens (input
including cache, and output), mean cost and accuracy. `manual` overrides `correct`. The totals:
- **savings/question:** the off arm's mean cost minus the on arm's;
- **questions:** the on-arm runs, the questions the Hive answered and whose sessions it distilled;
- **hive spend:** the sum of `llm_calls.csv`. With `--since TIMESTAMP`, it is instead every `llm_calls` row since
  then, read from Postgres, for example to include the backfill;
- **net:** savings × questions − Hive spend.

Tests: `python3 -m unittest discover -s scripts/experiment` and `pnpm --filter worker test`.
