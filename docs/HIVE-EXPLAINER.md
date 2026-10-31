# The Hive: one shared memory for our AI assistants

*A short explainer of what I'm building and why. Status as of October 28, 2026.*

## The problem

More and more of our work goes through AI coding assistants. I use one called Hermes. They're good at reading code and answering questions, but each one starts every session knowing nothing about our team.

So the same work gets repeated. If my assistant spends ten minutes figuring out why a service runs on a certain port, yours will spend the same ten minutes tomorrow, and so will mine next week. We pay for that every time, in time and in AI usage costs. Decisions made while chatting with an assistant also tend to disappear, because nobody writes them down.

## The idea

Give all of our assistants one shared memory, called **the Hive**, running on a machine we control.

The Hive holds **facts**: short statements that stay true and useful for weeks. For example:

- "The Hive's database uses port 5544 because the other project on that machine already uses the usual port."
- "We chose Postgres over DynamoDB for reporting because it needs joins."
- "Never call the notifications service directly from a web request; queue a job instead."

A fact isn't a to-do item, and it isn't something you'd find by reading the README. It's the kind of thing a new teammate would otherwise have to ask someone about.

## How it works, day to day

1. **You ask your assistant something.** Before it answers, the Hive quietly hands it the few facts that relate to your question. This takes about 30 milliseconds and doesn't use any paid AI.
2. **The assistant answers and says which facts it used,** with a short ID like `[hive:194b2b7f]`. That lets you check where an answer came from.
3. **New things get saved.** You can tell the assistant "remember that…", and the Hive also keeps a record of each conversation. Later, a background job will pull durable facts out of those records.
4. **A person approves shared facts.** A fact meant for everyone stays "proposed" until a reviewer (me, for now) approves it, so one assistant's mistake doesn't spread to everyone. Notes about you personally skip the review and are only ever visible to you.

Nothing is deleted. A wrong fact is marked as withdrawn and kept for history. Each fact remembers where it came from (the conversation or the file and line), so you can always ask why the assistant believes it.

## Keeping it cheap

The point is to save money, so the design avoids spending it:

- **Finding facts is free.** Matching a question to facts by meaning uses a small open-source model running on our own Mac, not a paid service.
- **The assistant only gets what's relevant.** Facts that don't clearly relate to the question are left out, and a fact is given to a conversation only once.
- **Every cost is recorded.** Any paid AI call the Hive makes is logged with what it cost, so savings and spending can be compared directly.

## What's built so far

The first three of six steps are done and running on my Mac:

- **The service and database:** storing facts and conversations, with access tokens per person.
- **Search:** by exact words and by meaning, returning results in about 36–71 ms even with 10,000 facts.
- **The Hermes connection:** a plugin that feeds facts to the assistant, records conversations, and lets the assistant look up, save, and withdraw facts.

An early, single test shows why this matters. I asked the same question about the project three ways:

- **With the Hive:** 1 AI call, about 4.6 cents.
- **With the Hive available but not used automatically:** 2 calls, about 5.6 cents.
- **Without the Hive** (the assistant searched the code itself): 3 calls, about 16 cents.

That's one question, so it's a hint rather than a result. Measuring this properly is the last step.

## What's next

- **Steps 4 and 5:** read our code repositories and their documents (Markdown, PDF, Word, Excel, PowerPoint) directly; regularly re-check that each fact's source still says what it used to; automatically suggest facts from finished conversations; add a simple web page for approving them.
- **Step 6, the real test:** about fifteen real questions about one of our projects, each asked with the Hive switched on and switched off. We compare how much each run cost and whether the answer was right. If the savings don't clearly beat the cost of running the Hive, we stop.

## Deliberately left out for now

- Teams and permissions beyond "one token per person, one reviewer"
- Deep code analysis, such as "what breaks if I change this function"
- Any cloud hosting; it all runs on one machine for the trial

These come later if the test says the idea is worth it.
