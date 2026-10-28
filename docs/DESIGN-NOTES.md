# Shared Company Memory for AI Assistants — design notes

Decisions settled in conversation (Oct 25, 2026). Companion to `hive-mind-proposal.pptx`
(built by `build_deck.py`; render check via `soffice` + `pdftoppm`).

## Positioning
- Commercial reference point: Viktor ("AI employee" in Slack/Teams, hosted, shared team memory, SSO/RBAC).
- Our wedge: runs inside the enterprise perimeter (own cloud, own models), open/forkable core (Hermes, MIT),
  **governed** memory (owners, approvals, provenance, retraction), and a delivery factory (ASF) behind the bot.
- Product is the governed memory; the bot is commodity.

## Architecture (4 layers, all Hermes extensions are plugins — no fork)
1. Surface — Hermes gateway (Slack first for PoC, Teams for enterprise). Per-user sessions are Hermes default.
2. Agent — Hermes core + plugins: memory provider, hive tools, identity hook (Entra later), ASF dispatch tools.
   Docker terminal backend per session; approval policy locked.
3. Hive — separate service, Postgres (+pgvector/FTS). Hermes talks to it via the `MemoryProvider` seam
   (`agent/memory_provider.py`: system_prompt_block, prefetch, sync_turn, tools, on_memory_write, on_session_end).
4. Factory — ASF. Pluggable `DeployTarget` seam (deploy/health/logs/teardown/promote; typed artifacts;
   capabilities advertised to the planner). Cloud Run first, `noop`/PR-only also. ASF completions auto-write
   `system` candidates back to the hive.

## Hive data model
- Episodes (immutable evidence refs) → Claims (governance unit) → Pages (compiled from promoted claims) →
  Index (hybrid search, entitlement-filtered) → Synthesis (nightly per-domain digest).
- Claim: type (system | capability | decision | glossary | lesson), evidence links, author+bot identity,
  scope (personal | team | enterprise), domain, confidence, status
  (candidate | reviewed | promoted | disputed | retracted), supersedes, bi-temporal columns
  (valid_from/valid_to, recorded_at/expired_at — Zep/Graphiti pattern).
- `system` entries Backstage-shaped; ingest from repos/OpenAPI/ASF registry/service catalog, not just chat.
- Forgetting = cascading retraction (Muse pattern) + index rebuild; hard delete only for legal/privacy.

## Governance (staged; provenance decides whether a human is involved, type decides strictness)
- Ingested ground truth (repo, deploy record) auto-promotes; auto-demotes when re-verification fails.
- Human/bot recollections always reviewed. Day 1: central curator. Phase 2: route to domain owner
  (needs ownership map). Phase 3: threshold auto-promotion for glossary/lesson only; never system/decision.
- Review happens **in chat** (Approve / Fix / Reject / Ask) — git is NOT the interface. Postgres keeps history.
- Ownership rule: no named owning team → capped at team scope (requester = steward). Keeps shadow IT visible.
- Role-aware presentation, not persona split: PM sees plain-language plan + preview link; engineer sees
  plan/diff and can take over. Same ASF gates underneath.

## Performance
- Hot path (per message): DB-only lookup of finished pages, entitlement-filtered, <~200ms; org-context block
  pre-computed/cached. No LLM calls.
- Cold path (background): extraction, consolidation, contradiction detection, re-verification, page rebuild,
  nightly digest.

## PoC plan
- Phase 1 (~4–6 wks): Slack bot, hive with `system` + `glossary`, approvals in chat, ingest a few repos,
  3–5 users. Measure citation rate + approvals/week. Can kill cheaply.
- Phase 2 (~6–8 wks): ASF + Cloud Run deploy seam; auto-record built things; decisions/lessons; nightly digest.
- Phase 3: Entra identity, Teams, isolation/hardening, service-catalog ingest, broader pilot.

## Open items
- Repo boundary: new repo depending on Hermes + ASF (leaning yes); ASF stays the factory.
- Store: Postgres first; graph DB only if traversal queries dominate.
- Name for the product/hive.
