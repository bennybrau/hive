---
version: distill-v7
---
You read {{source}}, and pick out the few facts a teammate would still want to know weeks from now. Most transcripts
contain none. Do not use tools.

A fact passes only if ALL of these hold:
- Durable: it stays true after this session (a decision taken, a rule, a trap, a preference), not a status update.
- Useful weeks later: someone starting a new task in this area would act differently knowing it.
- Not readable from the code, tests or docs: it records a why, a constraint or a trap, not how something works.
- Settled: it comes from a `user:` turn in which the person corrected, clarified, redirected or decided something
  ("no, do X", "always ...", "call it ...", "I'd rather ..."). An answer the person gave to the assistant's question
  (a `user_response` in `tool(clarify)` output) counts as the person deciding. The assistant's reasoning, plans, proposals and
  summaries are context only: they never make a fact on their own, even when the user answers "ok" or "thanks".

Never facts, even when true:
- Findings about bugs in the change being written or reviewed: they get fixed, then they're wrong.
- Implementation details (what a function does, how a value is encoded, which file holds what, what a test
  asserts).
- Routine procedure (how to update, deploy, run tests or check health), unless the user set it as a rule.
- Status, progress, versions, counts, costs, timings, PR/issue numbers, anything about this session itself.
- Setup or environment failures: a missing binary or file, unconfigured credentials, fresh-install errors. The person
  can fix these; they are not rules. If a setup step fixed it, the fix is at most a fact, never the failure.
- Claims that a tool or feature is broken or doesn't work ("X is broken", "Y can't be used from Z"). They outlive the
  problem and turn into refusals long after it was fixed.
- Transient errors that were resolved: if a retry or a later run worked, the failure is not a fact.
- One-off task details: what to do this time, for this ticket or this file only.
- Attempts that didn't work, written up as a method. If nothing was found that works, there is nothing to keep.

Default output, when nothing passes (chit-chat, status checks, routine edits, reviews, debugging that went nowhere):
{"facts":[]}

Otherwise at most 5 facts:
{"facts":[{"text":"...","kind":"...","scope":"...","quote":"...","locus":["path/to/file"]}]}

- text: ONE claim in one sentence of at most 35 words, readable without the transcript; add the reason when the
  transcript gives one. Two decisions are two facts; never bundle several into one. State the claim itself: leave
  out examples, numbers, history ("before this...") and who agreed to it. Write it as a standalone rule a teammate
  can act on, not the story of what happened: no PR/issue numbers, dates, run ids or narration (they stay in the
  quote). The same decision said twice is one fact.
- kind: one of decision, invariant, gotcha, preference, convention, system.
- scope: {{scopes}}
- quote: the exact characters of one short passage (under 200 chars, no "..." and no line breaks) {{quote_rule}},
  copied character for character (never reworded or summarised), keeping any markdown (backticks, asterisks) exactly
  as written. A quote that is not in the transcript is thrown away, and its fact with it.
- locus: optional, repo-relative file paths the fact is about.
- replaces: optional, the id of a fact listed below that this one corrects or updates.

{{related}}

{{remember}}

Reply with the JSON object only: no prose, no code fences.

The transcript follows.
