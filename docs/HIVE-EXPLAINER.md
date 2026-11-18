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

All six steps are built and running on my Mac: the service and search, the Hermes connection, reading our code and
documents, suggesting facts from conversations with a web page to approve them, a short briefing at the start of
each task, and the test.

**The test.** 16 real questions about one of our projects, each asked three times of an assistant with the Hive and
three times of one without it, graded by a separate AI against an answer key. The last run added a third assistant
with every Hive fact pasted into its instructions file (CLAUDE.md) instead. We ran it four times between November 7
and 15.

- **The first run looked good on answers and bad on cost:** 85% right with the Hive against 75% without, but the Hive
  spent more reading conversations for things to learn than it saved.
- **We fixed the cost:** the Hive now skips conversations where someone only asked questions and reads only what
  people said. Learning from my real day-to-day conversations costs about 19 cents a day, and 15 of the 18 facts it
  proposed in ten days were worth keeping.
- **The accuracy gap didn't hold up:** on the last run the Hive was 75% right, the plain assistant 71%, and the
  pasted-in file 77%. Those are within the normal run-to-run swing. The Hive was the cheapest of the three.

So on questions our code and docs can already answer, the Hive is as good as a well-kept instructions file, and a
little cheaper. It is not better at that, and we've stopped claiming it is.

## What's next

What a file can't do is the loop: someone corrects an assistant once, a reviewer approves it, and the next piece of
work follows it without anyone editing a file. That's what we measure next, on real work rather than a quiz. In the
meantime we're making the Hive installable by other people (published images and a one-line installer are done), so
a second person can run one.

## Deliberately left out for now

- Teams and permissions beyond "one token per person, one reviewer"
- Deep code analysis, such as "what breaks if I change this function"
- Any cloud hosting; it all runs on one machine for the trial

These come later if the test says the idea is worth it.
