#!/usr/bin/env bash
# Browser end-to-end for the dashboard: real Chromium (the Playwright image) against the running hive.
#
#   scripts/test-dashboard-e2e.sh
#
# Needs: the hive running (scripts/redeploy.sh) and docker. Mints a throwaway `e2e-<timestamp>` member
# token each run (left in place). The browser shares the hive container's network, so it reaches the
# hive at 127.0.0.1:8800 the same way on Mac and Linux.
set -euo pipefail
cd "$(dirname "$0")/.."
PW_VERSION=1.64.1   # the image tag and @playwright/test must match

hive=$(docker compose ps -q hive)
[ -n "$hive" ] || { echo "the hive isn't running: scripts/redeploy.sh"; exit 1; }

HIVE_E2E_TOKEN=$(docker compose exec -T hive node dist/cli/mint-token.js --name "e2e-$(date +%s)" --user "$(whoami)" --role member --json \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
export HIVE_E2E_TOKEN

# The spec imports @playwright/test, so install it next to the spec rather than run it from the npx cache.
docker run --rm --init --ipc=host --network "container:$hive" \
  -e HIVE_E2E_TOKEN -v "$PWD/apps/dashboard/e2e:/spec:ro" \
  "mcr.microsoft.com/playwright:v$PW_VERSION-noble" \
  bash -c "set -e; mkdir /tmp/e2e && cp /spec/*.spec.ts /tmp/e2e/ && cd /tmp/e2e \
    && npm init -y >/dev/null && npm install --silent --no-audit --no-fund @playwright/test@$PW_VERSION \
    && npx playwright test --reporter=list"
