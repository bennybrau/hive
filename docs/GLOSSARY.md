# Shared Company Memory — Glossary

Companion to `DESIGN-NOTES.md`. One line per term, grouped by where it lives.
Terms marked (EB) are borrowed from Entire Brain; (M0) from Mem0.

**Where the words come from.** Not all of this is standard nomenclature.
- *Field-standard:* episode/episodic memory (cognitive science; CoALA, Letta, Zep), extraction, retrieval, hybrid search, reranking, dedupe, provenance, citation, bi-temporal (SQL:2011; Zep/Graphiti), hot/cold path, supersedes (ADRs, knowledge graphs).
- *Borrowed from specific systems:* durable fact, distill, quality gate, brief, locus, verify, retract (Entire Brain); user/agent/run scoping (Mem0); candidate→promoted lifecycle (Entire Brain + CI promotion); owner/steward (data governance); cascading retraction (Muse); synthesis/nightly digest (Karpathy's LLM-wiki, Letta "sleep-time compute"); seam (Feathers).
- *Invented here:* Hive, Shelf, Page (as compiled view of promoted claims), Org-context block, Curator role, origin-decides-review rule. Expect to define these when talking to anyone outside the project.

## The four layers

- **Surface** — where people talk to their assistant: Slack first, Teams later. The Hermes gateway.
- **Agent** — one private Hermes session per person, extended by plug-ins (memory provider, hive tools, identity hook, factory dispatch). The commodity part.
- **Hive** — the shared, governed memory service. Postgres + search index. The product.
- **Factory** — ASF: plan → build → test → review → deploy. Whatever it builds gets recorded back into the hive.

## What's in the hive (the data model, bottom-up)

- **Episode** — immutable raw evidence: a chat exchange, a repo snapshot, a deploy record, an ASF run. Never edited, never summarized in place. (EB: "derive and cite, never extract and discard.")
- **Claim** — one small, durable statement derived from an episode: "The Invoice API is owned by Payments." The unit everything is governed on. Carries its evidence links, author, scope, type, confidence, status, and what it supersedes.
- **Page** — a clean, compiled view assembled from the *promoted* claims about one thing (a system, a decision, a term). This is what assistants actually read.
- **Index** — the hybrid search (keyword + vector) over pages, filtered by what the asking person is allowed to see.
- **Synthesis** — the nightly job that reads new claims, spots contradictions and stale facts, rebuilds pages, and writes each owner a short digest.

## Claim attributes

- **Type** — what kind of fact: `system` (a service and how to use it), `capability` (a skill/tool assistants can use), `decision` (we chose X because Y), `glossary` (what a word means here), `lesson` (a gotcha learned the hard way).
- **Scope / Shelf** — who it's true for and who can see it: **Personal** (your assistant's notes about you; never leaves without you), **Team** (true for one team, visible to that team), **Company** (everyone's assistant can rely on it).
- **Status** — lifecycle: `candidate` → `reviewed` → `promoted`, or sideways to `disputed` / `retracted`. Only promoted claims compile into pages.
- **Provenance** — the evidence anchors a claim points back to (episode id, repo + commit, deploy record, chat permalink). What lets the assistant answer "why do you think that?" (EB: blameable.)
- **Origin** — how the claim got in: `ingested` (read from a system of record), `distilled` (extracted from conversation by the background job), `authored` (a person typed "remember that…"). Origin decides whether a human reviews it.
- **Confidence** — the extractor's or author's self-rating; a routing hint, not truth.
- **Supersedes** — pointer to the older claim this one replaces, so history is a chain, not an overwrite.
- **Bi-temporal** — two clocks per claim: `valid_from / valid_to` (when it was true in the world) and `recorded_at / expired_at` (when the hive knew it). Lets the assistant say "that was true until March" instead of blurring then and now.
- **Locus** (EB) — *where* in the system a claim applies: a repo, package, service, or endpoint. Index key alongside type, so "the 8 facts about the thing you're touching" beats "200 facts about the company."

## How claims move

- **Ingest** — pulling ground truth from systems of record: repos, OpenAPI specs, service catalog, ASF's registry, deploy logs. Produces `system` claims automatically.
- **Ground truth** — a claim whose evidence is a machine-readable source rather than someone's recollection. Auto-promotes; auto-demotes when re-verification fails.
- **Distill / Extraction** (EB, M0) — the background pass that turns conversation into candidate claims. Runs hourly, costs tokens, never on the hot path.
- **Run record** (invented) — one merged ASF run (ticket, approved plan, review, PR link) kept as trusted history: searchable and used by the brief, never distilled into candidates or reviewed.
- **Remember request** (invented) — a person telling the agent to remember something ("remember this", "from now on ..."); flagged by the plugin and distilled at once instead of waiting for session end.
- **Quality gate** (EB) — the rule the extractor applies before emitting anything: durable, useful weeks later, not already discoverable from code/README, resolved not pending. Default outcome is *record nothing*.
- **Dedupe** (M0) — on write, check existing claims for the same fact before adding another copy.
- **Review** — a human decides on a candidate: **Approve / Fix / Reject / Ask**. Happens in chat, three taps. Git is not the interface.
- **Promote** — move a claim up a shelf (team → company). Requires the owner of that domain.
- **Verify** (EB) — re-check a claim's evidence against the live source (does the repo still say this? does the service still respond?). Scheduled, deterministic, no LLM.
- **Retract** — mark a claim no longer true. Kept as history, not deleted.
- **Cascading retraction** — retracting a claim also retracts everything derived only from it, then rebuilds the affected pages, so a bad fact can't creep back via a summary. Hard delete only for legal/privacy.

## People and permissions

- **Owner** — the named team responsible for a system or domain. Owners approve what the company shelf says about their stuff.
- **Steward** — the person responsible for a team-shelf claim with no owning team. The requester by default. Caps the claim at team scope until an owner exists, which keeps shadow IT visible instead of hidden.
- **Curator** — Day-1 stand-in for all owners: one person reviews everything until an ownership map exists.
- **Ownership map** — the lookup from system/domain → owning team. Needed before review can be routed; Phase 2.
- **Entitlement filter** — applied at search time: a person only ever sees pages on shelves they're allowed to read. Same idea as Mem0's "always scope the search."
- **Role-aware presentation** — same underlying plan and gates, shown as plain language + preview link to a PM, as diff + takeover to an engineer. Not separate personas.

## Runtime

- **Hot path** — everything that happens while someone waits for a reply: look up finished pages, filter by entitlement, hand them to the assistant. Database only, no LLM calls, target well under 250 ms.
- **Cold path** — everything that can run later: extraction, dedupe, contradiction detection, verification, page rebuilds, the nightly digest.
- **Org-context block** — the pre-computed slice of company shelf injected into every assistant's system prompt (what we do, how we deploy, key vocabulary). Cached, not searched.
- **Brief** (EB) — a bounded, task-shaped context packet: the relevant pages, code locations, likely tests, and known gotchas for *this* task. What the hive hands the agent instead of raw search hits.
- **Citation** — the assistant naming the page (and its evidence) it leaned on. The PoC's primary success metric: citation rate.
- **Digest** — the nightly message to each owner: new candidates waiting, contradictions found, facts that failed verification.
- **MemoryProvider seam** — Hermes' plug-in interface for external memory (`system_prompt_block`, `prefetch`, `sync_turn`, `tools`, `on_memory_write`, `on_session_end`). The hive plugs in here; so does Mem0 for the personal shelf.
- **DeployTarget seam** — ASF's pluggable deploy step (deploy / health / logs / teardown / promote). Cloud Run first.

## Why it saves tokens (the PoC question)

- **Replace re-discovery with lookup.** Today each agent re-reads the repo, re-asks Slack, re-derives "who owns Payments." A promoted page is read once, from a DB, by every agent.
- **Pages instead of transcripts.** Agents receive a few hundred tokens of compiled fact, not the 20K-token conversation it came from.
- **Extract once, cold.** The one LLM pass per episode happens in the background, not per user per session.
- **Count is a cost** (EB). Fewer, higher-altitude claims scoped by locus beat a big flat list — both for the token budget and for a human trying to read it.
