#!/usr/bin/env bash
# Browser end-to-end for the dashboard: real Chromium (the Playwright image) against the running hive.
#
#   scripts/test-dashboard-e2e.sh
#
# settings.spec overwrites the hive's review digest config; it skips when a real one is saved, unless
# HIVE_E2E_DIGEST_OVERWRITE=1.
#
# Needs: the hive running (scripts/redeploy.sh) and docker. Mints a throwaway `e2e-<timestamp>` member
# token and an `e2e-curator-<timestamp>` curator token each run (left in place). The browser shares the
# hive container's network, so it reaches the hive at 127.0.0.1:8800 the same way on Mac and Linux.
set -euo pipefail
cd "$(dirname "$0")/.."
PW_VERSION=1.64.1   # the image tag and @playwright/test must match

hive=$(docker compose ps -q hive)
[ -n "$hive" ] || { echo "the hive isn't running: scripts/redeploy.sh"; exit 1; }

mint() {
  docker compose exec -T hive node dist/cli/mint-token.js --name "$1" --user "$(whoami)" --role "$2" --json \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'
}
HIVE_E2E_TOKEN=$(mint "e2e-$(date +%s)" member)
HIVE_E2E_CURATOR_TOKEN=$(mint "e2e-curator-$(date +%s)" curator)
export HIVE_E2E_TOKEN HIVE_E2E_CURATOR_TOKEN

# Four global facts nobody has used for 400 days, for the Stale tab to keep, fix, retire and pin.
stale_marker="zs$(date +%s)"
HIVE_E2E_STALE_IDS=$(docker compose exec -T postgres psql -U hive -d hive -v ON_ERROR_STOP=1 -tAq -c "
  insert into facts (text, kind, scope, origin, status, content_hash, valid_from, recorded_at)
  select t, 'decision', 'global', 'authored', 'active', md5(t), now() - interval '400 days', now() - interval '400 days'
  from (select 'Dashboard e2e stale fact ${stale_marker} #' || n as t from generate_series(1, 4) n) s
  returning id" | paste -sd, -)
export HIVE_E2E_STALE_IDS

# The spec imports @playwright/test, so install it next to the spec rather than run it from the npx cache.
docker run --rm --init --ipc=host --network "container:$hive" \
  -e HIVE_E2E_TOKEN -e HIVE_E2E_CURATOR_TOKEN -e HIVE_E2E_STALE_IDS -e HIVE_E2E_DIGEST_OVERWRITE -v "$PWD/apps/dashboard/e2e:/spec:ro" \
  "mcr.microsoft.com/playwright:v$PW_VERSION-noble" \
  bash -c "set -e; mkdir /tmp/e2e && cp /spec/*.spec.ts /tmp/e2e/ && cd /tmp/e2e \
    && npm init -y >/dev/null && npm install --silent --no-audit --no-fund @playwright/test@$PW_VERSION \
    && npx playwright test --reporter=list"
