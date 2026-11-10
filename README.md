# Hive

A shared, governed memory for a team's AI assistants. One service on a host we control;
every [Hermes](https://github.com/NousResearch/hermes-agent) instance on the team connects
to it through a memory-provider plugin and gets the same facts, with provenance, before it
starts a task.

Working name. Private while we vet it.

## Read first

- [docs/HIVE-EXPLAINER.md](docs/HIVE-EXPLAINER.md) — short, simple explainer to share: the problem, the idea, what's built, what's next.
- [docs/MVP-OVERVIEW.md](docs/MVP-OVERVIEW.md) — longer plain-English description of the full MVP plan.
- [docs/MVP-PLAN.md](docs/MVP-PLAN.md) — the implementation plan: scope, data model, HTTP API, plugin hooks, milestones M0–M6, experiment harness.
- [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md) — settled design decisions.
- [docs/manual/](docs/manual/README.md) — user manual for the web dashboard: Facts, Search, Repos, Review, Stats.
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

## Install (no checkout)

Published images: `ghcr.io/bennybrau/hive` (service + dashboard) and `ghcr.io/bennybrau/hive-worker`, for
linux/amd64 and linux/arm64. Each `vX.Y.Z` release attaches the compose file and `.env.example`. Needs only Docker
(while the repo is private: `gh auth login` and `docker login ghcr.io` first).

```bash
mkdir hive && cd hive
gh release download v0.1.0 -R bennybrau/hive -p docker-compose.release.yml -p .env.example
mv docker-compose.release.yml docker-compose.yml && mv .env.example .env
# in .env: POSTGRES_PASSWORD=$(openssl rand -hex 24), HIVE_SECRET_KEY=$(openssl rand -hex 32), HIVE_VERSION=0.1.0
docker compose up -d --wait
docker compose exec hive node dist/cli/mint-token.js --name jon-macbook --user jon --role curator   # your HIVE_TOKEN
docker compose exec hive node dist/cli/mint-token.js --name hive-worker --user hive-worker --role worker
# put that token in .env as HIVE_WORKER_TOKEN, then:
docker compose up -d --wait hive-worker
```

Repos to ingest: set `HIVE_REPOS_HOST_ROOT` in `.env` (unset = none). Ollama in a container instead of on the host:
`OLLAMA_URL=http://ollama:11434` and `docker compose --profile ollama up -d`. Upgrade: change `HIVE_VERSION`, then
`docker compose pull && docker compose up -d --wait`.

## Tests

```bash
scripts/test.sh          # service: vitest against the compose Postgres (throwaway hive_test db)
scripts/test-plugin.sh   # Hermes plugin: pytest against Hermes' own MemoryProvider code
pnpm typecheck
scripts/redeploy.sh      # rebuild + restart the hive container after code changes
scripts/e2e-plugin.sh    # real Hermes session through the plugin against the running hive (one model call)
```

## Meaning search (Ollama)

Embeddings come from Ollama running natively on the host (Metal GPU), reached from the container at
`host.docker.internal:11434`:

```bash
brew install ollama && ollama serve        # or the Ollama app
ollama pull nomic-embed-text
```

Without it the Hive still works, keyword-only; `/v1/status` shows `embeddings.state`.

## Status

- **M0** done: compose stack, full schema, bearer-token instances, `/health`, `/v1/status`, `setup.sh`, plugin stub.
- **M1** done: remember / list / retract facts, episodes, hybrid recall + search, background embed worker,
  cost ledger rows for embeddings. API: [docs/API.md](docs/API.md). Latency: `apps/hive/bench/recall.ts`.
- **M2** done: the Hermes plugin (`plugins/hive`, see its README): gated once-per-session prefetch,
  turn + session episodes, `hive_recall` / `hive_remember` / `hive_search` / `hive_retract` / `hive_status`.
  Live check: `scripts/e2e-plugin.sh`.
- **M3** done: register repos, incremental ingest of docs (Markdown, PDF, Word, PowerPoint, Excel) and
  commit messages, verify of every fact's anchors against the working tree, locus boost from the files you're
  changing. API: [docs/API.md](docs/API.md#repos-ingest--verify).
- **M4** in progress: review queue (approve / fix / reject), distill job queue, and the `hive-worker`
  container that distills facts from sessions with `claude -p` on the curator's subscription token
  (`PUT /v1/settings/agent-credential`; `HIVE_DISTILL_RUNNER=ollama` for a local model). Dashboard next.
