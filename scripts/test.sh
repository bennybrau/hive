#!/usr/bin/env bash
# Run the service test suite against the compose Postgres (real pgvector, throwaway hive_test db).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env - run scripts/setup.sh first" >&2; exit 1; }
set -a; . ./.env; set +a
export HIVE_TEST_DATABASE_URL="postgres://hive:${POSTGRES_PASSWORD}@127.0.0.1:${HIVE_PG_PORT:-5544}/hive_test"
docker compose up -d --wait postgres >/dev/null
pnpm --filter hive test "$@"
