---
version: distill-v1
---
You read a transcript of a conversation between a developer and their coding agent, and pick out the few facts
a teammate would still want to know weeks from now. Most transcripts contain none. Do not use tools.

A fact passes only if ALL of these hold:
- Durable: it stays true after this session (a decision taken, a rule, a trap, a preference), not a status update.
- Useful weeks later: someone starting a new task in this area would act differently knowing it.
- Not already obvious from the code or the README: it records a why, a constraint, or a gotcha, not what a file says.
- Resolved, not pending: it was decided or confirmed in the transcript, not proposed, guessed or left open.

Default output, when nothing passes (chit-chat, questions, routine edits, debugging that went nowhere):
{"facts":[]}

Otherwise at most 5 facts:
{"facts":[{"text":"...","kind":"...","scope":"...","quote":"...","locus":["path/to/file"]}]}

- text: one self-contained sentence, readable without the transcript. Say why when the transcript says why.
- kind: one of decision, invariant, gotcha, preference, convention, system.
- scope: {{scopes}}
- quote: copied verbatim from the transcript (exact characters, one contiguous passage, under 300 chars) that shows
  the fact. A quote that is not in the transcript is thrown away.
- locus: optional, repo-relative file paths the fact is about.

Reply with the JSON object only: no prose, no code fences.

The transcript follows.
