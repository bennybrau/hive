# M5 experiment: does the Hive pay for itself?

Status: **closed (2026-11-17).** Baseline 2026-11-07 (decision: change, not stop), re-runs during and after
[M5b](M5B_LEARNING_LOOP.md), and a final reading against the M5b bar with ten days of real-session spend: see
[Re-run after M5b](#re-run-after-m5b-final-2026-11-17). Decision: continue to M6; stop using question accuracy as the
go/stop measure.

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

## Head to head: Hive vs a hand-kept CLAUDE.md (2026-11-15)

The question engineers ask first: why not paste the same knowledge into CLAUDE.md? A third arm, **file**, answers it:
no Hive, but run in a worktree whose CLAUDE.md has every fact the on-arm can read pasted in under "Team knowledge"
(59 active facts, ASF repo + organisation, about 8.5k characters). All three arms ran in detached worktrees of ASF
`a1ada58`, same model (`claude-opus-5-5`), same 16 questions, answer key and judge, 3 runs each (144 sessions, seed
`3111383528`, 3 at a time): `scripts/experiment/run.sh --arms off,on,file --repeats 3 --jobs 3`. Results kept locally
in `scripts/experiment/results/claudemd-20261115b`.

Before any question, the runner now checks each arm is what it claims (canaries): the file session quotes the Team
knowledge section, the off session finds none, the on session received a Hive brief; afterwards it checks one
`POST /v1/brief` per on-arm session (48 of 48).

| | off (CLAUDE.md as it is) | on (CLAUDE.md + Hive) | file (CLAUDE.md + every Hive fact) |
|---|---|---|---|
| correct (judge) | 71% (34/48) | 75% (36/48) | 77% (37/48) |
| cost per question | $0.092 | $0.084 | $0.091 |
| input tokens per question | 196k | 184k | 209k |

Hive's own spend in the window: $0.041. Net vs off: +$0.31 over 48 questions.

By where the answer lives (off / on / file): code 50 / 67 / 78%, commits 75 / 83 / 83%, docs 100 / 89 / 89%,
"doesn't exist" 100 / 100 / 83%, the run-record question (`why-4`) 33 / 0 / 0%.

**Reading it:**
- **No arm is clearly ahead.** One answer is 2 points. On and file differ by one answer, on and off by two. Across
  four runs of the same questions the off arm alone has scored 75, 67, 75 and 71%.
- **Hive and a pasted file are level on accuracy**, and both are a few points above the plain repo, inside the noise.
- **Hive was the cheapest arm**, 8% under off (0.7¢ a question), with the fewest input tokens. The file arm costs the
  same as off: its extra 8.5k characters are loaded on every turn.
- **14 of 48 on-arm answers cited a Hive fact** (7 distinct). Three of those were graded wrong, each for leaving out a
  key point, not for what the fact said.
- **The run-record question is still missed with the brief** (`why-4`, 0 of 3): the detail lives in an ASF run's plan
  and review, and the brief did not deliver it.
- The answer key is unchanged and not stale (checked against `d404cdc` and `a1ada58`). `how-1` is debatable: the key
  calls `ticketProvider` required, and the api has always filled it in itself; every arm fails it.

**An earlier run (2026-11-14, 2 runs each) is void for the on arm.** Its on sessions sent no `POST /v1/brief` and
their recalls carried no `repo_key`: under a gateway-served CLI the plugin detects the repo from the gateway's
working directory, not the caller's, so it found none. The runner now sets `HIVE_REPO_KEY` for the on profile; the
plugin's detection is still to be fixed. That run's off and file arms were sound (75% and 75%, 24/32 each). Whether
the Nov 7–8 runs had the brief is not known.

**Decision:** stop quoting 81% vs 67%; the gap did not reproduce (now 75% vs 71%). What the numbers support: on
questions the repo can answer, Hive is as accurate as a hand-kept file holding the same facts, and slightly cheaper.
They do not show Hive beating a file. What Hive adds and a file doesn't is the loop: a person's correction is
captured, reviewed, and reaches the next ticket without anyone editing a file (shown live in the Nov 13 rehearsal).
That loop is what to measure next: corrections that didn't have to be repeated, on real tickets.

## Re-run after M5b (final, 2026-11-17)

M5b's last step: re-run the experiment once playbooks (WP6a–c) and use counts with retirement (WP7) were in, and
judge the result against the bar set after the baseline. Both were merged and running by 2026-11-08, so the
head-to-head above (2026-11-15) is that re-run: same 16 questions, answer key, judge and seed, with a third arm added.
No further run was made; another one would only add a fifth sample of the same spread. Playbook learning from
sessions (WP6d–e) is held in bennybrau/hive#10 and was not part of it.

### Baseline → after the cost fix → after M5b

| | baseline (11-07) | after the cost fix (11-08) | after M5b (11-15) |
|---|---|---|---|
| off: correct | 75% | 67% | 71% |
| on: correct | 85% | 81% | 75% |
| on minus off | +10 points | +14 points | +4 points |
| file arm (CLAUDE.md with every fact): correct | | | 77% |
| off: cost per question | $0.116 | $0.115 | $0.092 |
| on: cost per question | $0.097 | $0.097 | $0.084 |
| Hive spend in the run | $1.84 | $0.053 | $0.041 |
| **net over 48 on-arm questions** | **−$0.91** | **+$0.81** | **+$0.31** |

Costs fell in the last column for every arm, because the runner moved to detached worktrees of a newer ASF commit;
compare costs within a column, not across.

### Real-session spend (2026-11-08 to 2026-11-17)

The 11-07 decision asked for a week of real use before this reading, because every experiment session is a question
and question-only sessions are now skipped, which makes the run's Hive spend look smaller than real work's. Jon's own
Hermes has used the Hive plugin since 2026-11-08 (instance `jon-hermes`). From `llm_calls` joined to that instance's
episodes:

- **49 sessions read, $1.86 in all**, about 19¢ a day. Per session: median 2.3¢, mean 3.8¢, 90th percentile 8.1¢, max
  26¢. One session was skipped as question-only. The five largest reads were 40% of the spend.
- **The 1¢-per-session estimate above was low.** It came from one short correction session; real sessions run
  2.5k–29k input tokens a read (daily mean), so the cost follows session length.
- **18 candidate facts, 15 kept.** 4 are active where they were proposed, 11 were kept but moved to a better level
  (most from Everyone to the Hive repo, three about a family project to Just me) or merged into one fact, 1 was retired
  as a duplicate, 2 were rejected. About 12¢ per kept fact.
- Across the whole Hive, 121 of the 140 active facts have been handed to an agent at least once, and 17 have been cited.

### Against the bar

The bar from the baseline: **net ≥ $0 with on-arm accuracy at least 85%.**

- **Cost: passes on the experiment, not proven on real work.** The run nets +$0.31 and Hive was the cheapest arm. Real
  sessions cost about 19¢ a day to learn from; at the measured 0.8¢ saved per question that needs about 24 questions a
  day to break even, and what the Hive saves on real work (not questions) is unmeasured.
- **Accuracy: fails, and the measure is the wrong one.** 75% on the on-arm, under 85%. Across four runs the off-arm
  alone has scored 67–75%, so a 10-point bar sits inside the spread, and a CLAUDE.md holding the same facts scores
  the same as Hive. Questions the repo can already answer don't show what the Hive is for.

### Decision: continue to M6, measure the loop instead

Close M5b. The learning is now cheap enough to leave on (about 19¢ a day for one person, 15 of 18 proposals worth
keeping), and the experiment has said what it can: on questions the repo answers, Hive is as accurate as a hand-kept
file and slightly cheaper, not better. M5b's 85% bar is retired rather than chased with more prompt work. M6 (ship
as images, harden for other people) continues; its first pieces (release images, installer) are already merged.
The next measure is the one a file can't match: on real tickets, how often a correction said once is applied by later
work without being repeated, and what that costs, once a second person's Hive is running. Two things to watch in the
meantime: real-session spend as sessions get longer (cap or trim the largest reads if it climbs past ~50¢ a day), and
the playbook learning held in bennybrau/hive#10, which waits for more procedural facts from real sessions.
