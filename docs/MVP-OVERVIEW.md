# The Hive: a shared memory for our AI assistants

*Plain-English overview of the MVP plan. For engineers and technical PMs. Technical detail lives in `MVP-PLAN.md`.*

## The problem

Each of us now works with an AI assistant (we use **Hermes**, an open-source agent that runs in the terminal and in chat tools like Slack). Those assistants are good at reading code and answering questions, but every one of them starts from zero. When Priya's assistant figures out that the Payments team owns the Invoice API, Marcus's assistant doesn't know. Tomorrow, Priya's own assistant doesn't know either.

The cost shows up two ways:

- **Time and money.** Every assistant re-reads the same files, re-runs the same searches, and re-derives the same answers. That re-discovery is paid for in tokens (the unit AI models bill by) on every session, by every person.
- **Drift.** Decisions get made in a chat with an assistant and never written down. Six weeks later nobody remembers why the retry limit is three.

## The idea

Give all our assistants one **shared memory** that lives on a machine we control. Call it the **Hive**.

An assistant checks the Hive before it starts a task and gets the handful of things it should know: who owns what, decisions we've already made, gotchas in the area it's about to touch. When a session ends, anything worth keeping is proposed back to the Hive. A person approves it before anyone else's assistant relies on it.

The assistant is the commodity. The governed memory is the product.

## What's in the memory

The Hive stores **facts**: single, durable statements written so a future reader benefits from them. Examples:

- "Services in ASF are deployed to Cloud Run; the deploy step is pluggable."
- "The `GATE_POLICY` setting can only be changed at the org tier, never via environment variables."
- "We dropped the queue abstraction in March because it hid retries from the caller."

A fact is *not* something you can already find in the README or by reading the code, and it's not a to-do. The bar is: still true and useful weeks from now.

Each fact carries:

- **Kind** — what sort of thing it is: a *decision*, an *invariant* (a rule that must hold), a *gotcha*, a *preference*, a *convention*, or a *system* (a service and how to use it).
- **Scope** — who it's for. *Global* facts apply everywhere ("we use pnpm"). *Repo* facts apply to one codebase. *Personal* facts are your assistant's notes about you and never leave your view.
- **Origin** — how it got in: *authored* (someone typed "remember that…"), *distilled* (extracted from a past session), or *ingested* (read directly from a repo, spec, or deploy record).
- **Status** — *candidate* (proposed, not yet trusted), *active* (approved; assistants will use it), *superseded* (replaced by a newer fact; kept as history), or *retracted* (marked false; kept as history).
- **Provenance** — where it came from. The exact quote from the conversation, or the file and line in the repo. This is what lets an assistant answer "why do you think that?"

## How facts get in, and how they get trusted

Three doors in:

1. **By hand.** You tell your assistant "remember that the staging cluster is in eu-west-1, globally." It's saved as a candidate.
2. **Distilled from sessions.** When a session ends, a background job reads the transcript and pulls out anything that meets the bar above. It's deliberately strict; the default outcome is *nothing*. Each extracted fact quotes the lines it came from.
3. **Ingested from systems of record.** The Hive reads our repos, their `docs/` folders (Markdown, PDF, Word, Excel, PowerPoint), and the git log directly. Facts from this door are **ground truth**: no opinion involved, so they're active immediately.

One gate for anything shared: a candidate for global or repo scope stays a candidate until a person approves it. In the MVP that person is one **curator** (Jon). Review is three buttons in a web page: **Approve**, **Fix** (edit the wording), **Reject**. Personal facts skip the queue because they're yours.

One ongoing check: **verify**. On a schedule, the Hive re-reads every fact's source. If the quoted line in the repo has moved, the fact is flagged *drifted*; if it's gone, *missing*. A ground-truth fact whose source disappears is retracted automatically. Hand-written facts with no source are labelled *unverifiable* rather than pretending.

## How assistants use it

- **Recall, every message.** Before the assistant answers, the Hive hands it the ten most relevant active facts for its scope and the code it's touching. This is a plain database lookup with no AI involved, so it's fast (target: well under a quarter of a second) and free.
- **Brief, at the start of a task.** "Add rate limiting to the upload endpoint" gets a short packet: relevant facts, the files most likely involved, the tests near them, and known gotchas in that area.
- **Search, on demand.** Keyword search ("find `RetryPolicy`") and meaning search ("where did we talk about backpressure?") across facts, past session history, docs, and raw conversations.
- **Cite.** When an assistant uses a fact, it says so by id. Citation rate is our main signal that the memory is actually being used.

Meaning search works by turning text into vectors (lists of numbers that encode meaning) and finding the nearest ones. We generate those vectors with a small open-source model running locally on the Mac Studio (via **Ollama**), so that part costs nothing per call and nothing leaves the machine.

## What it runs on

- The **Hive** is one service plus a Postgres database, running in Docker on the Mac Studio next to the **ASF** (our Agentic Software Factory, the pipeline that turns tickets into reviewed PRs). The two don't share a database.
- Each person's **Hermes** connects with a URL and a token. Installing is one plugin and two settings. Your assistant works the same as before; it just knows more.
- A small **dashboard** (web page) shows the facts, the review queue, where each fact came from, and what the Hive has spent on AI calls.

Every AI call the Hive itself makes (distilling, embedding) is logged with its token count and estimated cost. That ledger is part of the product, not an afterthought.

## How we'll know if it works

The MVP ends with an experiment, not a demo. About fifteen real questions about the ASF codebase ("who owns the gate policy?", "why did we move to orphan-branch worktrees?", "where is identity resolved?") are each asked of an assistant twice: once with the Hive switched off, once with it on. For each run we record tokens used, whether the answer was correct, and which facts were cited. We also total what the Hive spent in the background over the same period.

The result is a number: tokens saved per question, minus the cost of keeping the memory. If that number isn't convincingly positive on real questions, we stop.

## What's deliberately not in the MVP

- **Code graph** (symbol-level "what calls this / what breaks if I change it"). File-level only for now; there's an open-source tool we can bolt on later if the experiment shows assistants ask those questions.
- **Teams and permissions.** The scope model is there, but enforcement is "one token per person, one curator." Microsoft Teams, SSO, and per-team owners come after the experiment.
- **Nightly contradiction detection.** The review queue shows "this looks similar to an existing fact"; a human decides.
- **ASF writing its results back automatically.** One webhook is included so completed ASF runs become sessions the Hive can distill; nothing fancier.

Roughly fifteen to eighteen focused days of work across six milestones. Each milestone ends with something runnable.

## Quick reference: the words we'll keep using

- **Hive** — the shared memory service. Working name.
- **Hermes** — the open-source AI assistant each of us runs; connects to the Hive through a plugin.
- **ASF** — Agentic Software Factory; our ticket-to-PR pipeline. Runs on the same machine as the Hive.
- **Fact** — one durable, useful, non-obvious statement. The unit everything else operates on.
- **Candidate / active / superseded / retracted** — a fact's life: proposed → approved → replaced or withdrawn. Nothing is deleted.
- **Scope** — who a fact is for: global, one repo, or personal.
- **Origin** — authored by a person, distilled from a session, or ingested from a system of record.
- **Provenance** — the source a fact points back to. Quote, file, line, commit.
- **Ground truth** — a fact read directly from a repo or record. Trusted without review; retracted automatically if its source disappears.
- **Distill** — the background job that extracts candidate facts from a finished session.
- **Verify** — the scheduled job that re-checks every fact's source and flags drift.
- **Curator** — the person who approves candidates for shared scope. One person in the MVP.
- **Recall** — the fast, no-AI lookup that hands an assistant relevant facts before it answers.
- **Brief** — the task-shaped packet (facts, files, tests, gotchas) an assistant gets at the start of a job.
- **Citation** — an assistant naming the fact it relied on.
- **Token** — the unit AI models bill in; roughly three-quarters of a word. "Token cost" is the money and the context space a session consumes.
- **Embedding / meaning search** — turning text into a vector so similar ideas match even with different words. Generated locally with Ollama.
- **Ollama** — a program that runs open-source AI models on our own machine.
- **Hot path / cold path** — work done while someone waits for a reply (must be fast, no AI) versus work done later in the background (can be slow, may use AI).
