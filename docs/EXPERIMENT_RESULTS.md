# M5 experiment: does the Hive pay for itself?

Status: **baseline done (2026-11-07). Decision: change, not stop.** The follow-up work is
[M5b](M5B_LEARNING_LOOP.md); its last step re-runs this experiment against the numbers below.

## Method

- **Questions:** the 16 in `scripts/experiment/questions.json` (#19), about ASF: who owns, how do I, why did we, where
  is, and two about things that don't exist. Each has an answer key of 1–3 points.
- **Arms:** two throwaway Hermes profiles cloned from the default profile (same model, `claude-opus-5-5`), both run in
  the ASF checkout (`7aface7`). *Off*: no memory provider. *On*: the Hive plugin with a member token, so it gets the
  first-turn brief (#18) and recall.
- **Runs:** 16 questions × 2 arms × 3 = 96 fresh `hermes -z` sessions, in shuffled order (seed `3111383528`).
- **Grading:** a judge (`claude-sonnet-5-5`, blind to the arm) marks an answer correct when it states every key point
  and contradicts none. For a "doesn't exist" question the answer must say so.
- **Hive spend:** every `llm_calls` row in the run window: the distill of each on-arm session.
- **What the Hive knew:** 92 active facts (about 20 of them decisions a person made in ASF gate notes and chat) and 115
  run records (merged ASF runs). Hive `26f39bb`.
- Results are kept locally (`scripts/experiment/results/full-20261107T2040`, git-ignored).

## Results

| question | off: cost | off: correct | on: cost | on: correct | saved per question |
|---|---|---|---|---|---|
| who-1 | $0.073 | 100% | $0.078 | 100% | −$0.004 |
| who-2 | $0.088 | 100% | $0.075 | 100% | $0.014 |
| who-3 | $0.133 | 67% | $0.084 | 67% | $0.049 |
| how-1 | $0.173 | 0% | $0.119 | 33% | $0.054 |
| how-2 | $0.163 | 100% | $0.081 | 100% | $0.082 |
| how-3 | $0.128 | 100% | $0.094 | 100% | $0.035 |
| how-4 | $0.155 | 100% | $0.118 | 100% | $0.038 |
| why-1 | $0.142 | 67% | $0.079 | 67% | $0.063 |
| why-2 | $0.098 | 100% | $0.080 | 100% | $0.018 |
| why-3 | $0.056 | 100% | $0.070 | 100% | −$0.014 |
| why-4 | $0.081 | 0% | $0.079 | 0% | $0.002 |
| why-5 | $0.125 | 100% | $0.132 | 100% | −$0.007 |
| where-1 | $0.115 | 100% | $0.110 | 100% | $0.005 |
| where-2 | $0.109 | 100% | $0.105 | 100% | $0.004 |
| none-1 | $0.135 | 67% | $0.163 | 100% | −$0.029 |
| none-2 | $0.086 | 0% | $0.086 | 100% | $0.000 |
| **all (48 runs per arm)** | **$0.116** | **75%** | **$0.097** | **85%** | **$0.019** |

By where the answer lives: in docs the Hive saved the most ($0.056 per question, input tokens 154k → 100k); in code
and commits about $0.015–0.018; for "doesn't exist" questions it cost a little more but was right every time
(100% vs 33%), because without it the assistant tended to describe something that isn't there.

21 of the 48 on-arm answers cited a Hive fact (`[hive:…]`), 7 distinct facts in all; no answer that cited a fact was
graded wrong.

**The total:**

| | |
|---|---|
| saved per question | $0.0193 |
| questions (on-arm runs) | 48 |
| saved | $0.93 |
| Hive spend (48 distills) | $1.84 |
| **net** | **−$0.91** |

## What went wrong

- **Almost all of the Hive's spend was reading sessions it couldn't learn from.** Each distill read about 9,000 fresh
  and 10,000 cached input tokens and wrote about 10 tokens: nearly every call found nothing. Every experiment session
  is a person asking one question; under the rule set on 2026-11-07, only what a person decides, corrects or asks to
  remember can become a fact, so these reads could never produce one. Most of the text read was tool output (files
  the agent opened), which the distiller is not allowed to quote anyway.
- **The grading is strict.** Two answers were marked wrong for one missing detail (`none-1` on: right, but didn't
  name `AUTH_MODE`; `why-1` off: right reason, cited ASF #68 instead of `bennybrau/hive#10`). Strictness applies to
  both arms, so the comparison stands; the answer key can be re-graded later from the saved answers.
- **`why-4` was missed by both arms.** Its answer lives in a run record (merged ASF run); neither arm got it, so
  run records aren't yet helping on that kind of question.

## Decision: change

The Hive does what it's for: answers were cheaper (−17%) and more often right (85% vs 75%), most clearly where the
answer is in docs or doesn't exist. It lost money only because it paid to read every session in full. That's a fixable
cost, not a reason to stop. [M5b](M5B_LEARNING_LOOP.md) fixes it, borrows what works in Hermes's own self-improvement,
and ends by re-running this experiment. The bar for M5b's re-run: **net ≥ $0 with on-arm accuracy at least 85%**.

## Re-run after M5b WP1, WP1b, WP3, WP4 (2026-11-07)

Same 16 questions, arms and seed (`3111383528`), 96 sessions. Hive `3c6f416` (question-only sessions skipped, distill
reads only what people said, `claude -p` without Claude Code's default system prompt and tools, `distill-v7`). Results
kept locally in `scripts/experiment/results/m5b-20261108T0055`.

| | baseline | re-run |
|---|---|---|
| off: cost per question | $0.116 | $0.115 |
| on: cost per question | $0.097 | $0.097 |
| saved per question | $0.019 | $0.018 |
| off: correct | 75% | 67% |
| on: correct | 85% | 81% |
| on minus off | +10 points | **+14 points** |
| Hive spend | $1.84 (48 distills at $0.038) | **$0.053** (6 distills at $0.009; 42 question-only sessions skipped) |
| **net** | **−$0.91** | **+$0.81** |

By where the answer lives (on vs off correct): code 89% vs 72%, commits 75% vs 58%, docs 100% vs 89%, "doesn't exist"
83% vs 67%; the run-record question (`why-4`) is still missed by both.

**Against the bar** (net ≥ $0, on-arm ≥ 85%): cost passes, from −$0.91 to +$0.81. Accuracy is 81%, under the 85% bar,
but the off arm fell further (75% → 67%) on the same questions and answer key, so the drop is grading and model spread
between runs (3 runs per question), not the Hive getting worse; the gap the Hive adds grew from 10 to 14 points.

**Caveat:** every experiment session is a question, so nearly all distills were skipped. Real work has corrections and
decisions in it, which are distilled at about 1¢ each now (measured live: $0.0119 for a correction session). The
Hive's own spend on real sessions isn't measured yet: Jon's main Hermes doesn't use the Hive plugin, and the past
week's distill spend ($6.36, 193 calls) is almost all one-off work (the ASF backfill on 2026-11-07, the baseline run
and live probes), before WP1b.

**Decision:** the cost problem is fixed. Continue with WP6 (playbooks) and WP7 (use counts, retirement); WP8 re-runs
this. Before WP8, turn the Hive plugin on for real Hermes use for a week so that run can report real-session spend.
