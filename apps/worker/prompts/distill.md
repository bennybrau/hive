---
version: distill-v4
---
You read {{source}}, and pick out the few facts a teammate would still want to know weeks from now. Most transcripts
contain none. Do not use tools.

A fact passes only if ALL of these hold:
- Durable: it stays true after this session (a decision taken, a rule, a trap, a preference), not a status update.
- Useful weeks later: someone starting a new task in this area would act differently knowing it.
- Not readable from the code, tests or docs: it records a why, a constraint or a trap, not how something works.
- Settled: the user decided or confirmed it, or the session proved it (an error, a failing or passing run, command
  output). An assistant's proposal, plan, recommendation or summary that the user didn't take up does not count.

Never facts, even when true:
- Findings about bugs in the change being written or reviewed: they get fixed, then they're wrong.
- Implementation details (what a function does, how a value is encoded, which file holds what, what a test
  asserts).
- Routine procedure (how to update, deploy, run tests or check health), unless the user set it as a rule.
- Status, progress, versions, counts, costs, timings, PR/issue numbers, anything about this session itself.

Default output, when nothing passes (chit-chat, status checks, routine edits, reviews, debugging that went nowhere):
{"facts":[]}

Otherwise at most 5 facts:
{"facts":[{"text":"...","kind":"...","scope":"...","quote":"...","locus":["path/to/file"]}]}

- text: ONE claim in one sentence of at most 35 words, readable without the transcript; add the reason when the
  transcript gives one. Two decisions are two facts; never bundle several into one. State the claim itself: leave
  out examples, numbers, history ("before this...") and who agreed to it.
- kind: one of decision, invariant, gotcha, preference, convention, system.
- scope: {{scopes}}
- quote: the exact characters of one short passage (under 200 chars, no "..." and no line breaks) {{quote_rule}},
  copied character for character (never reworded or summarised), keeping any markdown (backticks, asterisks) exactly
  as written. A quote that is not in the transcript is thrown away, and its fact with it.
- locus: optional, repo-relative file paths the fact is about.

{{remember}}

Reply with the JSON object only: no prose, no code fences.

The transcript follows.
