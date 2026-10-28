# Hive

A shared, governed memory for a team's AI assistants. One service on a host we control;
every [Hermes](https://github.com/NousResearch/hermes-agent) instance on the team connects
to it through a memory-provider plugin and gets the same facts, with provenance, before it
starts a task.

Working name. Private while we vet it.

## Read first

- [docs/MVP-OVERVIEW.md](docs/MVP-OVERVIEW.md) — plain-English description for colleagues.
- [docs/MVP-PLAN.md](docs/MVP-PLAN.md) — the implementation plan: scope, data model, HTTP API, plugin hooks, milestones M0–M6, experiment harness.
- [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md) — settled design decisions.
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — vocabulary, with notes on which terms are standard, borrowed, or ours.

## Layout (planned)

```
apps/hive/     TypeScript (Fastify) service + jobs — owns Postgres (pgvector + FTS)
apps/web/      React dashboard, served by the service
plugins/hermes-memory-hive/   Python MemoryProvider plugin for Hermes
scripts/       setup, dev, experiment harness
docs/          design and plan
```

## Status

M0 (skeleton) not started. See the milestone list in `docs/MVP-PLAN.md`.
