#!/usr/bin/env bash
# Browser end-to-end for the dashboard: real Chromium (the Playwright image) against the running hive.
#
#   scripts/test-dashboard-e2e.sh
#
# settings.spec overwrites the hive's review digest config; it skips when a real one is saved, unless
# HIVE_E2E_DIGEST_OVERWRITE=1.
#
# Needs: the hive running (scripts/redeploy.sh) and docker. Mints a throwaway `e2e-<timestamp>` member
# token and an `e2e-curator-<timestamp>` curator token each run, and revokes both on exit. The browser shares the
# hive container's network, so it reaches the hive at 127.0.0.1:8800 the same way on Mac and Linux.
#
# Every fact and team the specs make carries this run's marker (HIVE_E2E_RUN, `zr<timestamp>`). The four
# stale facts get their own `zs<timestamp>` marker instead and sit in a throwaway repo, `repo:e2e/stale-<marker>`,
# so no brief or recall in the specs reads them and records a use. The specs retire their own facts; on exit the
# script retracts any active or candidate fact with the run marker, or that is a stale fact or supersedes one,
# deletes the marker's team-scoped facts and `e2e-` teams, and fails if an active or candidate fact by the same
# rule is left.
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
member_name="e2e-$(date +%s)"
curator_name="e2e-curator-$(date +%s)"
HIVE_E2E_TOKEN=$(mint "$member_name" member)
HIVE_E2E_CURATOR_TOKEN=$(mint "$curator_name" curator)
export HIVE_E2E_TOKEN HIVE_E2E_CURATOR_TOKEN

run="zr$(date +%s)"
HIVE_E2E_RUN=$run
export HIVE_E2E_RUN

cleanup() {
  local status=$?
  [ -n "$run" ] || { echo "cleanup: no run marker, refusing to touch the hive" >&2; exit 1; }
  echo "== cleanup ($run)"
  # The specs retire what they made; this catches the rest, e.g. a member's personal facts or a failed test.
  local mine="status in ('active', 'candidate') and (text like '%${run}%'"
  [ -z "${HIVE_E2E_STALE_IDS:-}" ] \
    || mine="$mine or id::text = any(string_to_array('$HIVE_E2E_STALE_IDS', ','))
      or supersedes::text = any(string_to_array('$HIVE_E2E_STALE_IDS', ','))"
  mine="$mine)"
  psql_ -c "update facts set status = 'retracted', status_note = 'e2e cleanup' where $mine" || status=1
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
  # This run's two tokens are revoked last (the team deletes above use the curator one); the rows stay, as
  # revoked instances always do.
  psql_ -c "update instances set revoked_at = now() where name in ('$member_name', '$curator_name') and revoked_at is null" \
    || { echo "cleanup: couldn't revoke $member_name / $curator_name" >&2; status=1; }
  local live
  live=$(psql_ -c "select count(*) from instances where name in ('$member_name', '$curator_name') and revoked_at is null") || live="?"
  [ "$live" = 0 ] || { echo "cleanup: $live e2e token(s) still active" >&2; status=1; }
  local left
  left=$(psql_ -c "select count(*) from facts where $mine") || left="?"
  echo "cleanup: $left active or candidate e2e fact(s) left"
  if [ "$left" != 0 ]; then
    echo "cleanup: $left active or candidate fact(s) containing $run, or stale or superseding a stale fact, are left" >&2
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT

# Four facts nobody has used for 400 days, for the Stale tab to keep, fix, retire and pin. Their marker isn't
# built from $run and their repo is theirs alone (see the header).
stale_marker="zs$(date +%s)"
HIVE_E2E_STALE_IDS=$(psql_ -c "
  insert into facts (text, kind, scope, origin, status, content_hash, valid_from, recorded_at)
  select t, 'decision', 'repo:e2e/stale-${stale_marker}', 'authored', 'active', md5(t), now() - interval '400 days', now() - interval '400 days'
  from (select 'Dashboard e2e stale fact ${stale_marker} #' || n as t from generate_series(1, 4) n) s
  returning id" | paste -sd, -)
export HIVE_E2E_STALE_IDS

# The spec imports @playwright/test, so install it next to the spec rather than run it from the npx cache.
docker run --rm --init --ipc=host --network "container:$hive" \
  -e HIVE_E2E_TOKEN -e HIVE_E2E_CURATOR_TOKEN -e HIVE_E2E_RUN -e HIVE_E2E_STALE_IDS -e HIVE_E2E_DIGEST_OVERWRITE -v "$PWD/apps/dashboard/e2e:/spec:ro" \
  "mcr.microsoft.com/playwright:v$PW_VERSION-noble" \
  bash -c "set -e; mkdir /tmp/e2e && cp /spec/*.spec.ts /tmp/e2e/ && cd /tmp/e2e \
    && npm init -y >/dev/null && npm install --silent --no-audit --no-fund @playwright/test@$PW_VERSION \
    && npx playwright test --reporter=list"
