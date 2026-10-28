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
plugins/hive/  Python MemoryProvider plugin for Hermes (dir name = provider name)
scripts/       setup, dev, experiment harness
docs/          design and plan
```

## Quickstart (host)

Needs Docker, Node 22+, pnpm.

```bash
pnpm install
scripts/setup.sh --curator-user jon --curator-name jon-macbook   # .env, stack up, prints HIVE_URL + curator HIVE_TOKEN
curl -s localhost:8800/health                                     # {"ok":true,"db":"up",...}
```

More tokens (one per Hermes instance):

```bash
docker compose exec hive node dist/cli/mint-token.js --name jon-studio --user jon
```

Other machines: set `HIVE_BIND=0.0.0.0` (or the Tailscale IP) in `.env`, then `docker compose up -d`.

Connect a Hermes: see [plugins/hive/README.md](plugins/hive/README.md).

## Tests

```bash
scripts/test.sh          # service: vitest against the compose Postgres (throwaway hive_test db)
scripts/test-plugin.sh   # Hermes plugin: pytest against Hermes' own MemoryProvider code
pnpm typecheck
```

## Status

M0 (skeleton) done: compose stack (pgvector Postgres + service), full MVP schema, bearer-token
instances, `/health`, `/v1/status`, `setup.sh`, and a Hermes plugin stub with a `hive_status` tool.
Next: M1 (facts, episodes, hybrid search). See `docs/MVP-PLAN.md`.
