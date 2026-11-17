# Contributing to Hive

Thanks for helping. This page covers how to get a dev environment running, what CI checks, and how pull requests
are reviewed and merged.

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), and you agree to
follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug or ask for a feature** in [issues](https://github.com/bennybrau/hive/issues).
- **Report a security problem privately.** See [SECURITY.md](SECURITY.md). Don't open a public issue for it.
- **Pick up an issue.** Comment on it before starting anything large, so two people don't build the same thing.

## Dev setup

You need **Node 22 or later**, **pnpm 11** (`corepack enable` picks the pinned version from `package.json`) and
**Docker**. **Ollama** with `nomic-embed-text` is optional: without it, search is keyword-only.

```bash
pnpm install
scripts/setup.sh --curator-user alice --curator-name alice-laptop   # writes .env, starts the stack, prints a curator token
curl -s http://127.0.0.1:8800/health
```

The stack is its own compose project (`hive`): the service on `:8800`, Postgres (pgvector) on host port `5544`.
After a code change, `scripts/redeploy.sh` rebuilds and restarts it.

## Before you open a PR

CI (`.github/workflows/ci.yml`) runs these. Run them locally first:

```bash
pnpm typecheck
scripts/test.sh            # service tests, against a throwaway hive_test database in the compose Postgres
pnpm --filter worker test
scripts/test-plugin.sh     # Hermes plugin tests, against the pinned Hermes in plugins/hive/HERMES_REF
```

For dashboard changes also run `cd apps/dashboard && pnpm test`, and `scripts/test-dashboard-e2e.sh` for the
browser tests. CI doesn't run either one.

- **No formatter.** The repo has no Prettier config, so a formatter rewrites whole files. Match the surrounding style.
- **DB migrations** are additive: add the next numbered file in `apps/hive/migrations/` and never edit one that
  has shipped.
- **The plugin and the MCP connector stay in step.** A change to what the Hermes plugin shows or accepts needs the
  same change in `apps/hive/src/mcp.ts`.
- **Distill prompt changes** (`apps/worker/prompts/distill.md`) are scored with `scripts/eval-distill.sh`
  (see `scripts/eval-distill/README.md`). Put the before and after numbers in the PR.

## Rules the code must keep

- Recall and brief (the hot path) are SQL only: no model call. Model work runs as jobs in `hive-worker`.
- Keyword search always works. Embeddings are an extra layer and may be missing.
- Nothing is deleted: facts move `candidate → active → superseded | retracted`, with a note.
- Facts for the team wait for a curator. Personal facts are private to their owner.
- Every model call the Hive makes is logged with its cost in `llm_calls`.
- Hermes itself is never modified for Hive. Everything lives in the service or the plugin.

## Pull requests

- **One change per PR**, on its own branch off `main`.
- **Conventional Commit titles** (`feat: …`, `fix: …`, `docs: …`, `chore: …`). PRs are **squash-merged** and the
  PR title and body become the commit on `main`, so write them as a commit message.
- **Linear history.** Rebase onto `main` to pick up changes. Don't merge `main` into your branch.
- Put `Closes #123` in the PR body so the issue closes on merge.
- Add or update tests with the change, and update `docs/` (especially `docs/API.md`) when behaviour changes.
