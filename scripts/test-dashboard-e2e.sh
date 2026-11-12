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
#
# Every fact and team the specs make carries this run's marker (HIVE_E2E_RUN, `zr<timestamp>`). The specs
# retire their own facts; on exit the script retracts any active fact with the marker, deletes the marker's
# team-scoped facts and `e2e-` teams, and fails if an active fact with the marker is left.
set -euo pipefail
cd "$(dirname "$0")/.."
PW_VERSION=1.64.1   # the image tag and @playwright/test must match

URL="http://127.0.0.1:${HIVE_PORT:-8800}"

hive=$(docker compose ps -q hive)
[ -n "$hive" ] || { echo "the hive isn't running: scripts/redeploy.sh"; exit 1; }

psql_() { docker compose exec -T postgres psql -U hive -d hive -v ON_ERROR_STOP=1 -tAq "$@"; }
mint() {
  docker compose exec -T hive node dist/cli/mint-token.js --name "$1" --user "$(whoami)" --role "$2" --json \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'
}
HIVE_E2E_TOKEN=$(mint "e2e-$(date +%s)" member)
HIVE_E2E_CURATOR_TOKEN=$(mint "e2e-curator-$(date +%s)" curator)
export HIVE_E2E_TOKEN HIVE_E2E_CURATOR_TOKEN

run="zr$(date +%s)"
HIVE_E2E_RUN=$run
export HIVE_E2E_RUN

cleanup() {
  local status=$?
  [ -n "$run" ] || { echo "cleanup: no run marker, refusing to touch the hive" >&2; exit 1; }
  echo "== cleanup ($run)"
  # The specs retire what they made; this catches the rest, e.g. a member's personal facts or a failed test.
  psql_ -c "update facts set status = 'retracted', status_note = 'e2e cleanup'
    where status = 'active' and text like '%${run}%'" || status=1
  # A team can't be deleted while a fact is in it, so the marker's team-scoped facts go first.
  psql_ <<SQL || status=1
begin;
create temp table e2e_facts on commit drop as
  select id from facts where scope like 'team:e2e-%' and text like '%${run}%';
update facts set supersedes = null where supersedes in (select id from e2e_facts);
delete from reviews where fact_id in (select id from e2e_facts);
delete from facts where id in (select id from e2e_facts);
commit;
SQL
  for key in $(psql_ -c "select key from teams where key like 'e2e-%${run}%'"); do
    curl -fsS -o /dev/null -X DELETE -H "authorization: Bearer $HIVE_E2E_CURATOR_TOKEN" "$URL/v1/teams/$key" \
      || { echo "cleanup: couldn't delete team $key" >&2; status=1; }
  done
  local left
  left=$(psql_ -c "select count(*) from facts where status = 'active' and text like '%${run}%'") || left="?"
  if [ "$left" != 0 ]; then
    echo "cleanup: $left active fact(s) containing $run are left" >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT

# Four global facts nobody has used for 400 days, for the Stale tab to keep, fix, retire and pin.
HIVE_E2E_STALE_IDS=$(psql_ -c "
  insert into facts (text, kind, scope, origin, status, content_hash, valid_from, recorded_at)
  select t, 'decision', 'global', 'authored', 'active', md5(t), now() - interval '400 days', now() - interval '400 days'
  from (select 'Dashboard e2e stale fact ${run}s #' || n as t from generate_series(1, 4) n) s
  returning id" | paste -sd, -)
export HIVE_E2E_STALE_IDS

# The spec imports @playwright/test, so install it next to the spec rather than run it from the npx cache.
docker run --rm --init --ipc=host --network "container:$hive" \
  -e HIVE_E2E_TOKEN -e HIVE_E2E_CURATOR_TOKEN -e HIVE_E2E_RUN -e HIVE_E2E_STALE_IDS -e HIVE_E2E_DIGEST_OVERWRITE -v "$PWD/apps/dashboard/e2e:/spec:ro" \
  "mcr.microsoft.com/playwright:v$PW_VERSION-noble" \
  bash -c "set -e; mkdir /tmp/e2e && cp /spec/*.spec.ts /tmp/e2e/ && cd /tmp/e2e \
    && npm init -y >/dev/null && npm install --silent --no-audit --no-fund @playwright/test@$PW_VERSION \
    && npx playwright test --reporter=list"
