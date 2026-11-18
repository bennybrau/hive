# Hive

A shared, governed memory for a team's AI assistants. One service on a host you control;
every [Hermes](https://github.com/NousResearch/hermes-agent) instance on the team connects
to it through a memory-provider plugin and gets the same facts, with provenance, before it
starts a task. Claude Code and other MCP clients connect to the same store.

What it does that shared instruction files (CLAUDE.md, AGENTS.md, skills) don't:

- **Learns from the work.** When a person corrects or redirects an agent, the Hive proposes it as a fact.
  Nobody has to edit a file.
- **A person reviews before it spreads.** Facts for the team wait in a review queue for a curator. Personal facts
  apply right away and stay private.
- **Scoped and cited.** Each fact sits at a level (personal, repo, team, organisation), carries where it came from,
  and agents cite it as `[hive:<id>]`. Agents get only the facts relevant to the task, not the whole store.
- **Kept current.** A fact that changes is superseded in one place. Facts drawn from repo docs are re-checked
  against the files and retired when their source goes.

Status: an MVP, used daily by one small team. "Hive" is a working name. Licensed under Apache-2.0.

## Read first

- [docs/JOINING.md](docs/JOINING.md) — for a teammate joining a Hive: what is sent, who sees it, how to turn it off.
- [docs/HIVE-EXPLAINER.md](docs/HIVE-EXPLAINER.md) — short, simple explainer to share: the problem, the idea, what's built, what's next.
- [docs/MVP-OVERVIEW.md](docs/MVP-OVERVIEW.md) — longer plain-English description of the full MVP plan.
- [docs/MVP-PLAN.md](docs/MVP-PLAN.md) — the implementation plan: scope, data model, HTTP API, plugin hooks, milestones M0–M6, experiment harness.
- [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md) — settled design decisions.
- [docs/manual/](docs/manual/README.md) — user manual for the web dashboard: Facts, Search, Repos, Review, Stats.
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — vocabulary, with notes on which terms are standard, borrowed, or ours.

## Layout

```
apps/hive/       TypeScript (Fastify) service + jobs; owns Postgres (pgvector + FTS); MCP endpoint at /mcp
apps/worker/     hive-worker: cold-path jobs (distill with `claude -p` or a local model, evals, experiment)
apps/dashboard/  React dashboard, served by the service
plugins/hive/    Python MemoryProvider plugin for Hermes (dir name = provider name)
scripts/         setup, tests, e2e, distill eval, experiment harness
docs/            design, plan, API, user manual
```

## Quickstart (host)

Needs Docker, Node 22+, pnpm.

```bash
pnpm install
scripts/setup.sh --curator-user alice --curator-name alice-laptop  # .env, stack up, prints HIVE_URL + curator HIVE_TOKEN
curl -s localhost:8800/health                                     # {"ok":true,"db":"up",...}
```

More tokens (one per Hermes instance):

```bash
docker compose exec hive node dist/cli/mint-token.js --name bob-laptop --user bob
```

Other machines: set `HIVE_BIND=0.0.0.0` (or the Tailscale IP) in `.env`, then `docker compose up -d`.

Connect a Hermes: see [plugins/hive/README.md](plugins/hive/README.md).
Connect Claude Code (or any MCP client) to `<HIVE_URL>/mcp`: see [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md).

## Install (no checkout)

```bash
curl -fsSL https://raw.githubusercontent.com/bennybrau/hive/main/scripts/install.sh | bash
```

Needs only Docker and curl. It asks a few questions (each has a default; Enter takes it), brings the Hive up in
`~/hive` and prints the dashboard URL and a token per person, with the line to connect Claude Code and Hermes.
Re-run `~/hive/install.sh` to change an answer. Every prompt, its env var for `--non-interactive`, and `--project`
for a second Hive on one host: [docs/INSTALL.md](docs/INSTALL.md).

### Manual install

Published images: `ghcr.io/bennybrau/hive` (service + dashboard) and `ghcr.io/bennybrau/hive-worker`, for
linux/amd64 and linux/arm64. Each `vX.Y.Z` release attaches the compose file, `hive.env.example` and
`hive-plugin.tar.gz` (the Hermes plugin, top directory `hive/`). Needs only Docker.

```bash
mkdir hive && cd hive
V=v0.1.0; R=https://github.com/bennybrau/hive/releases/download/$V
curl -fsSL -o docker-compose.yml $R/docker-compose.release.yml
curl -fsSL -o .env $R/hive.env.example
# in .env: POSTGRES_PASSWORD=$(openssl rand -hex 24), HIVE_SECRET_KEY=$(openssl rand -hex 32), HIVE_VERSION=0.1.0
docker compose up -d --wait
docker compose exec hive node dist/cli/mint-token.js --name alice-laptop --user alice --role curator   # your HIVE_TOKEN
docker compose exec hive node dist/cli/mint-token.js --name hive-worker --user hive-worker --role worker
# put that token in .env as HIVE_WORKER_TOKEN, then:
docker compose up -d --wait hive-worker
```

Repos to ingest: set `HIVE_REPOS_HOST_ROOT` in `.env` (unset = none). Ollama in a container instead of on the host:
`OLLAMA_URL=http://ollama:11434` and `docker compose --profile ollama up -d`. Upgrade: change `HIVE_VERSION`, then
`docker compose pull && docker compose up -d --wait`.

## Backups and restore

The `backup` service runs `pg_dump` every night at `HIVE_BACKUP_TIME` (default 03:00, in `TZ`, default UTC). The
dumps are `hive-YYYYMMDD-HHMM.dump` (`pg_dump -Fc`, mode 600) in the `hive-backups` volume, or in `HIVE_BACKUP_DIR`
on the host when set. It keeps the newest dump of each of the last 7 days and of each of the last 4 Sundays, and
always the newest one; other files there are left alone. Set `HIVE_BACKUP_COPY_DIR` to a second host directory (a
NAS, a synced folder) to get a copy of each dump there, with the same retention. `HIVE_BACKUPS=off` turns it off.

Take one now: `scripts/backup-now.sh` in a checkout, or from the install directory
`docker compose -p <project> run --rm --no-deps -T backup once`. `install.sh doctor` warns when the newest dump is
over 26 hours old, or when there is none.

Practice a restore now and then: `scripts/restore.sh latest` restores the newest dump into a new database
`hive_restore_<timestamp>`, leaving the live one alone, prints each table's rows restored and live, and prints the
command to drop it. `scripts/restore.sh <file> --into hive --yes` restores over the live database (hive and
hive-worker are stopped meanwhile). Keep copies off this machine with `HIVE_BACKUP_DIR` / `HIVE_BACKUP_COPY_DIR`, or
`docker compose -p <project> cp backup:/backups/<file> .`. No checkout: see
[docs/INSTALL.md](docs/INSTALL.md#backups-and-restore).

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

The roadmap lives in [GitHub milestones](https://github.com/bennybrau/hive/milestones). Done: the service and
schema, hybrid recall and search, the Hermes plugin, repo/doc ingest and verify, distill with a review queue and
dashboard, briefs, teams, and the Claude Code (MCP) connector. Measured results, with their caveats:
[docs/EXPERIMENT_RESULTS.md](docs/EXPERIMENT_RESULTS.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately: [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE). See also [NOTICE](NOTICE).
