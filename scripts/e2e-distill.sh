#!/usr/bin/env bash
# M4 acceptance (#15), end to end on a REAL stack: a Hermes session (profile A) states a decision -> the worker
# distills it into a candidate quoting the turn -> a curator approves it -> another instance (profile B) recalls it
# and cites it. Prints the timing of every step, the distill's tokens and cost, and a summary block for the PR.
# Uses throwaway profiles hive-e2e-a / hive-e2e-b and tokens it mints; everything is cleaned up on exit.
#
#   scripts/e2e-distill.sh            # approve over HTTP
#   scripts/e2e-distill.sh --manual   # approve in the dashboard yourself; the script waits for it
#
# Needs: the stack running (scripts/redeploy.sh) with the hive-worker, the agent credential set
# (PUT /v1/settings/agent-credential), `hermes` on PATH, and an ASF checkout (ASF_DIR, default
# ~/dev/agentic-software-factory). E2E_CANDIDATE_TIMEOUT (default 60) is the seconds from the session's end
# to the candidate. Costs two short Hermes sessions and two distills.
set -euo pipefail
cd "$(dirname "$0")/.."
MANUAL=0
case "${1:-}" in --manual) MANUAL=1 ;; "") ;; *) echo "usage: $0 [--manual]" >&2; exit 2 ;; esac
URL="http://127.0.0.1:${HIVE_PORT:-8800}"
ASF_DIR="${ASF_DIR:-$HOME/dev/agentic-software-factory}"
CLAIM_TIMEOUT=60
CANDIDATE_TIMEOUT="${E2E_CANDIDATE_TIMEOUT:-60}"
PA=hive-e2e-a PB=hive-e2e-b
RUN="$(date +%Y%m%d%H%M%S)-$RANDOM"   # instance names are unique forever (revoked rows stay)

[ -d "$ASF_DIR/.git" ] || { echo "no ASF checkout at $ASF_DIR (set ASF_DIR)" >&2; exit 1; }
command -v hermes >/dev/null || { echo "hermes is not on PATH" >&2; exit 1; }
curl -fsS "$URL/health" >/dev/null || { echo "the hive isn't answering at $URL (scripts/redeploy.sh)" >&2; exit 1; }

psql_() { docker compose exec -T postgres psql -U hive -d hive -v ON_ERROR_STOP=1 -tAq -c "$1"; }
api() { # api <token> <method> <path> [json body]
  if [ $# -ge 4 ]; then
    curl -fsS -X "$2" -H "authorization: Bearer $1" -H "content-type: application/json" --data "$4" "$URL$3"
  else
    curl -fsS -X "$2" -H "authorization: Bearer $1" "$URL$3"
  fi
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
mint() { # mint <name> <user> <role> -> "<instance id> <token>"
  docker compose exec -T hive node dist/cli/mint-token.js --name "$1" --user "$2" --role "$3" --json \
    | json 'd["id"], d["token"]'
}
STEP_T=$SECONDS
TIMINGS=""
step_done() { local s=$((SECONDS - STEP_T)); echo "  -> $1: ${s}s"; TIMINGS="$TIMINGS$(printf '%-28s %4ss' "$1" "$s")"$'\n'; STEP_T=$SECONDS; }
fail() { echo "FAIL: $*" >&2; exit 1; }

A_ID="" B_ID="" C_ID=""
START_AT="$(psql_ "select now()")"
cleanup() {
  set +e
  echo "== cleanup"
  if [ -n "$B_ID" ]; then # B's own session is distilled too: let it finish so its cost is recorded
    for _ in $(seq 60); do
      left=$(psql_ "select count(*) from distill_jobs j join episodes e on e.id = j.episode_id
                    where e.instance_id = '$B_ID' and j.status in ('queued', 'claimed')")
      [ "$left" = 0 ] && break
      sleep 2
    done
    [ "$left" = 0 ] || echo "  B's distill job still running after 120 s; deleting it anyway"
  fi
  if [ -n "$A_ID$B_ID$C_ID" ]; then
    ids=$(printf "'%s'," $A_ID $B_ID $C_ID); ids="${ids%,}"
    psql_ "begin;
      create temp table e2e_eps on commit drop as select id from episodes where instance_id in ($ids);
      update llm_calls set episode_id = null where episode_id in (select id from e2e_eps);
      create temp table e2e_facts on commit drop as select id from facts
        where recorded_at >= '$START_AT' and (author_instance_id in ($ids)
          or id in (select fact_id from anchors where episode_id in (select id from e2e_eps)));
      update facts set supersedes = null where supersedes in (select id from e2e_facts);
      delete from reviews where fact_id in (select id from e2e_facts);
      delete from facts where id in (select id from e2e_facts);
      delete from anchors where episode_id in (select id from e2e_eps);
      delete from distill_jobs where episode_id in (select id from e2e_eps);
      delete from episodes where id in (select id from e2e_eps);
      update instances set revoked_at = now() where id in ($ids) and revoked_at is null;
      commit;" >/dev/null && echo "  probe facts, jobs, episodes deleted; tokens revoked (llm_calls kept)"
  fi
  rm -rf "$HOME/.hermes/profiles/$PA" "$HOME/.hermes/profiles/$PB"
}
trap cleanup EXIT

echo "== setup"
read -r A_ID A_TOK <<<"$(mint "$PA-$RUN" "$PA" member)"
read -r B_ID B_TOK <<<"$(mint "$PB-$RUN" "$PB" member)"
read -r C_ID C_TOK <<<"$(mint "hive-e2e-curator-$RUN" hive-e2e-curator curator)"
for p in "$PA:$A_TOK" "$PB:$B_TOK"; do
  name="${p%%:*}" tok="${p#*:}" dir="$HOME/.hermes/profiles/${p%%:*}"
  rm -rf "$dir"
  hermes profile create "$name" --clone --no-alias --description "throwaway: hive distill e2e" >/dev/null
  mkdir -p "$dir/plugins" && ln -sfn "$PWD/plugins/hive" "$dir/plugins/hive"
  (umask 077; printf 'HIVE_URL=%s\nHIVE_TOKEN=%s\n' "$URL" "$tok" >> "$dir/.env")
  hermes -p "$name" config set memory.provider hive >/dev/null
  status=$(hermes -p "$name" memory status 2>&1)   # no `| grep -q`: early exit + pipefail = false failure
  case "$status" in *"available ✓"*) ;; *) echo "$status"; fail "plugin not available in $name" ;; esac
done
step_done "setup"

echo "== 1. profile A states a decision"
PORT=$((7000 + RANDOM % 1000))
usage_a="$(mktemp)"
(cd "$ASF_DIR" && hermes -p "$PA" -z "No tools needed, just acknowledge in one sentence. We settled it today: ASF's staging \
hive listens on port $PORT, because the dev hive already owns 8800 on the shared build host and staging must run \
next to it." --usage-file "$usage_a") | sed 's/^/  A: /'
EP=""
for _ in $(seq 10); do
  EP=$(psql_ "select id from episodes where instance_id = '$A_ID' and kind = 'session' order by created_at desc limit 1")
  [ -n "$EP" ] && break
  sleep 1
done
[ -n "$EP" ] || fail "no session episode from profile A"
echo "  session episode $EP (port $PORT)"
step_done "1. session A"

echo "== 2. distill: job claimed, candidate in the queue"
since_end() { psql_ "select round(extract(epoch from now() - created_at))::int from episodes where id = '$EP'"; }
JOB="" CLAIMED_S="" FACT=""
while :; do
  read -r JOB js <<<"$(psql_ "select id, status from distill_jobs where episode_id = '$EP'" | tr '|' ' ')"
  [ -n "$JOB" ] || fail "no distill job for episode $EP"
  [ "$js" != queued ] && break
  [ "$(since_end)" -le "$CLAIM_TIMEOUT" ] || fail "job $JOB not claimed within ${CLAIM_TIMEOUT}s (is hive-worker running?)"
  sleep 1
done
CLAIMED_S=$(since_end)
echo "  job $JOB $js after ${CLAIMED_S}s"
while :; do
  js=$(psql_ "select status || coalesce(': ' || error, '') from distill_jobs where id = '$JOB'")  # before the queue read
  FACT=$(api "$C_TOK" GET "/v1/review/queue?origin=distilled&limit=100" | python3 -c '
import json, sys
ep, port = sys.argv[1], sys.argv[2]
for c in json.load(sys.stdin)["candidates"]:
    if any(a["episode_id"] == ep and a["quote"] for a in c["anchors"]) and port in c["text"]:
        print(c["id"]); break' "$EP" "$PORT")
  [ -n "$FACT" ] && break
  case "$js" in failed*|skipped*|done*) fail "job $JOB is $js, and no candidate quoting the turn" ;; esac
  [ "$(since_end)" -le "$CANDIDATE_TIMEOUT" ] || fail "no candidate within ${CANDIDATE_TIMEOUT}s of the session's end (job: $js)"
  sleep 2
done
CANDIDATE_S=$(since_end)
api "$C_TOK" GET "/v1/facts/$FACT" | json '"  candidate %s: %s\n  quote: %s" % (d["fact"]["id"], d["fact"]["text"], [a["quote"] for a in d["anchors"] if a["episode_id"] == "'"$EP"'"][0])'
echo "  candidate after ${CANDIDATE_S}s from the session's end"
step_done "2. distill -> candidate"

echo "== 3. approve"
if [ $MANUAL = 1 ]; then
  echo "  approve it in the dashboard: $URL/review  (fact ${FACT:0:8})"
  for _ in $(seq 300); do
    st=$(api "$C_TOK" GET "/v1/facts/$FACT" | json 'd["fact"]["status"]')
    [ "$st" = active ] && break
    [ "$st" = candidate ] || fail "fact is $st, not approved"
    sleep 2
  done
  [ "$st" = active ] || fail "not approved within 10 minutes"
else
  api "$C_TOK" POST "/v1/facts/$FACT/review" '{"action":"approve","note":"e2e-distill"}' >/dev/null
  st=$(api "$C_TOK" GET "/v1/facts/$FACT" | json 'd["fact"]["status"]')
  [ "$st" = active ] || fail "fact is $st after approve"
fi
echo "  fact $FACT is active"
step_done "3. approve"

echo "== 4. profile B recalls it"
usage_b="$(mktemp)"
answer=$(cd "$ASF_DIR" && hermes -p "$PB" -z "Without running commands or reading files: what port does ASF's staging hive \
listen on, and why? One sentence." --usage-file "$usage_b")
echo "  B: $answer"
recall_ok=1
case "$answer" in *"$PORT"*) ;; *) echo "FAIL: B's answer doesn't contain $PORT" >&2; recall_ok=0 ;; esac
case "$answer" in *"[hive:${FACT:0:8}]"*) ;; *) echo "FAIL: B's answer doesn't cite [hive:${FACT:0:8}]" >&2; recall_ok=0 ;; esac
[ $recall_ok = 1 ] || exit 1
step_done "4. recall in B"

echo "== 5. cost of the distill"
COST=$(api "$C_TOK" GET "/v1/stats?days=1&episode_id=$EP" | python3 -c '
import json, sys
calls = json.load(sys.stdin)["calls"]
if not calls: sys.exit("no llm_calls row for the episode")
t = {k: sum(c[k] or 0 for c in calls) for k in ("input_tokens", "output_tokens", "cached_tokens", "cost_usd", "duration_ms")}
t["model"] = ",".join(sorted({c["model"] or "?" for c in calls}))
print("model={model} calls={n} input_tokens={input_tokens} output_tokens={output_tokens} cached_tokens={cached_tokens} "
      "cost_usd={cost_usd:.4f} duration_ms={duration_ms}".format(n=len(calls), **t))')
echo "  job $JOB $COST"
step_done "5. cost"

cat <<EOF

==== e2e-distill summary ($(date -u +%Y-%m-%dT%H:%MZ)) ====
decision      ASF staging hive port $PORT (session episode $EP)
claimed       ${CLAIMED_S}s after the session's end (limit ${CLAIM_TIMEOUT}s)
candidate     ${CANDIDATE_S}s after the session's end (limit ${CANDIDATE_TIMEOUT}s), fact ${FACT:0:8}
approve       $([ $MANUAL = 1 ] && echo dashboard || echo "POST /v1/facts/:id/review")
recall        B answered with $PORT and [hive:${FACT:0:8}]
distill       job $JOB $COST
steps
$(printf '%s' "$TIMINGS" | sed 's/^/  /')
OK
EOF
