#!/usr/bin/env bash
# End-to-end: a REAL Hermes one-shot session using the hive plugin against the running hive.
# Uses a throwaway profile (hive-e2e) so your own profile is untouched. Costs one short model call.
#
#   scripts/e2e-plugin.sh            # create profile if needed, ask one question, check the hive saw it
#
# Needs: the hive running (scripts/redeploy.sh), facts seeded (scripts/seed/), `hermes` on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE=hive-e2e
PDIR="$HOME/.hermes/profiles/$PROFILE"
URL="http://127.0.0.1:${HIVE_PORT:-8800}"

if [ ! -d "$PDIR" ]; then
  hermes profile create "$PROFILE" --clone --no-alias --description "throwaway: hive plugin e2e" >/dev/null
fi
mkdir -p "$PDIR/plugins" && ln -sfn "$PWD/plugins/hive" "$PDIR/plugins/hive"
if ! grep -q '^HIVE_TOKEN=' "$PDIR/.env" 2>/dev/null; then
  tok=$(docker compose exec -T hive node dist/cli/mint-token.js --name "$PROFILE" --user "$(whoami)" --role member --json \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
  (umask 077; printf 'HIVE_URL=%s\nHIVE_TOKEN=%s\n' "$URL" "$tok" >> "$PDIR/.env")
fi
hermes -p "$PROFILE" config set memory.provider hive >/dev/null
status=$(hermes -p "$PROFILE" memory status 2>&1)   # no `| grep -q`: early exit + pipefail = false failure
case "$status" in *"available ✓"*) ;; *) echo "plugin not available in $PROFILE:"; echo "$status"; exit 1 ;; esac

before=$(docker compose exec -T postgres psql -U hive -d hive -tAc "select count(*) from episodes")
usage="$(mktemp)"
answer=$(hermes -p "$PROFILE" -z "Without running commands or reading files: what host port does the Hive's Postgres use, and why? One sentence." --usage-file "$usage")
echo "answer: $answer"
python3 - "$usage" <<'EOF'
import json, sys
u = json.load(open(sys.argv[1]))
print(f"usage: api_calls={u['api_calls']} total_tokens={u['total_tokens']} est_cost=${u['estimated_cost_usd']:.4f}")
EOF
after=$(docker compose exec -T postgres psql -U hive -d hive -tAc "select count(*) from episodes")
fail=0
echo "$answer" | grep -q "5544" || { echo "FAIL: answer doesn't contain the port from the hive"; fail=1; }
echo "$answer" | grep -qE '\[hive:[0-9a-f]{8}\]' || { echo "FAIL: answer doesn't cite a hive fact"; fail=1; }
[ "$((after - before))" -ge 2 ] || { echo "FAIL: expected a turn + session episode, got $((after - before))"; fail=1; }
[ $fail = 0 ] && echo "OK: recalled, cited, and recorded ($((after - before)) episodes)"
exit $fail
