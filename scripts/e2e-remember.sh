#!/usr/bin/env bash
# M5 remember requests (#58), end to end on a REAL stack. A curator (profile hive-e2e-cur) and a member
# (hive-e2e-mem) each say "remember this" in a Hermes turn; the plugin flags the turn and the worker turns it into
# one fact marked asked. Checks:
#   1. curator: exactly one fact from the turn, active and asked
#   2. member: exactly one fact, an asked candidate, first in the review queue (only other asked candidates may be
#      ahead of it)
#   (1 and 2 count facts authored by the instance or anchored to the turn since the start, so a `hive_remember`
#    call by the agent plus the distill must still make one fact)
#   3. a "do you remember ...?" turn is not flagged: no distill job for it and no fact
# Exits non-zero on the first failure and prints a summary block for the PR.
# Uses throwaway profiles hive-e2e-cur / hive-e2e-mem and tokens it mints; everything is cleaned up on exit.
#
# Needs: the stack running (scripts/redeploy.sh) with the hive-worker, the agent credential set
# (PUT /v1/settings/agent-credential), `hermes` on PATH, and an ASF checkout (ASF_DIR, default
# ~/dev/agentic-software-factory). E2E_FACT_TIMEOUT (default 90) is the seconds from the turn to its fact.
# Costs three short Hermes sessions and their distills.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="http://127.0.0.1:${HIVE_PORT:-8800}"
ASF_DIR="${ASF_DIR:-$HOME/dev/agentic-software-factory}"
FACT_TIMEOUT="${E2E_FACT_TIMEOUT:-90}"
PC=hive-e2e-cur PM=hive-e2e-mem
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
fail() { echo "FAIL: $*" >&2; exit 1; }

C_ID="" M_ID=""
START_AT="$(psql_ "select now()")"
cleanup() {
  set +e
  echo "== cleanup"
  if [ -n "$C_ID$M_ID" ]; then
    ids=$(printf "'%s'," $C_ID $M_ID); ids="${ids%,}"
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
  rm -rf "$HOME/.hermes/profiles/$PC" "$HOME/.hermes/profiles/$PM"
}
trap cleanup EXIT

# settle <instance id>: wait until none of the instance's distill jobs is queued or claimed (its session too).
settle() {
  local left
  for _ in $(seq "$FACT_TIMEOUT"); do
    left=$(psql_ "select count(*) from distill_jobs j join episodes e on e.id = j.episode_id
                  where e.instance_id = '$1' and j.status in ('queued', 'claimed')")
    [ "$left" = 0 ] && return 0
    sleep 1
  done
  fail "distill jobs of instance $1 still running after ${FACT_TIMEOUT}s (is hive-worker running?)"
}
# last_turn <instance id> -> "<episode id> <remember_request>"
last_turn() {
  local t=""
  for _ in $(seq 10); do
    t=$(psql_ "select id, coalesce(metadata->>'remember_request', 'false') from episodes
               where instance_id = '$1' and kind = 'turn' and created_at >= '$START_AT'
               order by created_at desc limit 1" | tr '|' ' ')
    [ -n "$t" ] && break
    sleep 1
  done
  [ -n "$t" ] || fail "no turn episode from instance $1"
  echo "$t"
}
# turn_facts <instance id> <episode id>: "<id>|<status>|<asked>|<agent first>" for each fact authored by the
# instance or anchored to the turn since the start. "agent first" is whether it was recorded before the turn
# episode, i.e. the agent's own hive_remember call that the distill deduped into.
turn_facts() {
  psql_ "select f.id, f.status, coalesce(f.metadata->>'asked', 'false'), f.recorded_at < e.created_at
         from facts f, episodes e
         where e.id = '$2' and f.recorded_at >= '$START_AT'
           and (f.author_instance_id = '$1' or f.id in (select fact_id from anchors where episode_id = '$2'))
         order by f.recorded_at"
}
# remember <profile> <instance id> <port> -> the turn episode id, after its job and the session's are done
remember() {
  (cd "$ASF_DIR" && hermes -p "$1" -z "Remember this: ASF's staging hive listens on port $3, because the dev hive \
already owns 8800 on the shared build host and staging must run next to it. It's a team decision for this repo.") \
    | sed "s/^/  $1: /" >&2
  read -r ep flagged <<<"$(last_turn "$2")"
  [ "$flagged" = true ] || fail "turn $ep from $1 wasn't flagged as a remember request"
  [ -n "$(psql_ "select id from distill_jobs where episode_id = '$ep' and priority = 1")" ] \
    || fail "no priority-1 distill job for turn $ep"
  settle "$2"
  js=$(psql_ "select status || coalesce(': ' || error, '') from distill_jobs where episode_id = '$ep'")
  [ "$js" = done ] || fail "remember job for turn $ep is $js"
  echo "$ep"
}

echo "== setup"
read -r C_ID C_TOK <<<"$(mint "$PC-$RUN" "$PC" curator)"
read -r M_ID M_TOK <<<"$(mint "$PM-$RUN" "$PM" member)"
for p in "$PC:$C_TOK" "$PM:$M_TOK"; do
  name="${p%%:*}" tok="${p#*:}" dir="$HOME/.hermes/profiles/${p%%:*}"
  rm -rf "$dir"
  hermes profile create "$name" --clone --no-alias --description "throwaway: hive remember e2e" >/dev/null
  mkdir -p "$dir/plugins" && ln -sfn "$PWD/plugins/hive" "$dir/plugins/hive"
  (umask 077; printf 'HIVE_URL=%s\nHIVE_TOKEN=%s\n' "$URL" "$tok" >> "$dir/.env")
  hermes -p "$name" config set memory.provider hive >/dev/null
  status=$(hermes -p "$name" memory status 2>&1)   # no `| grep -q`: early exit + pipefail = false failure
  case "$status" in *"available ✓"*) ;; *) echo "$status"; fail "plugin not available in $name" ;; esac
done

echo "== 1. curator asks to remember"
C_PORT=$((7000 + RANDOM % 1000))
T0=$SECONDS
C_EP=$(remember "$PC" "$C_ID" "$C_PORT")
C_S=$((SECONDS - T0))
facts=$(turn_facts "$C_ID" "$C_EP")
echo "$facts" | sed 's/^/  fact: /'
[ "$(printf '%s\n' "$facts" | grep -c .)" = 1 ] || fail "curator: expected exactly one fact, got: $facts"
IFS='|' read -r C_FACT st asked C_AGENT <<<"$facts"
[ "$st" = active ] || fail "curator's fact $C_FACT is $st, not active"
[ "$asked" = true ] || fail "curator's fact $C_FACT isn't marked asked"

echo "== 2. member asks to remember"
M_PORT=$((C_PORT + 1000))
T0=$SECONDS
M_EP=$(remember "$PM" "$M_ID" "$M_PORT")
M_S=$((SECONDS - T0))
facts=$(turn_facts "$M_ID" "$M_EP")
echo "$facts" | sed 's/^/  fact: /'
[ "$(printf '%s\n' "$facts" | grep -c .)" = 1 ] || fail "member: expected exactly one fact, got: $facts"
IFS='|' read -r M_FACT st asked M_AGENT <<<"$facts"
[ "$st" = candidate ] || fail "member's fact $M_FACT is $st, not a candidate"
[ "$asked" = true ] || fail "member's fact $M_FACT isn't marked asked"
M_POS=$(api "$C_TOK" GET "/v1/review/queue?limit=100" | python3 -c '
import json, sys
cs = json.load(sys.stdin)["candidates"]
ids = [c["id"] for c in cs]
if sys.argv[1] not in ids: sys.exit("not in the queue")
i = ids.index(sys.argv[1])
if not cs[i].get("metadata", {}).get("asked"): sys.exit("in the queue without metadata.asked")
ahead = [c["id"][:8] for c in cs[:i] if not c.get("metadata", {}).get("asked")]
if ahead: sys.exit("unasked candidates ahead of it: " + ", ".join(ahead))
print(i + 1)' "$M_FACT") || fail "member's candidate $M_FACT in the queue: see above"
echo "  candidate ${M_FACT:0:8} is #$M_POS in the queue"

echo "== 3. member asks a question"
Q_START="$(psql_ "select now()")"
(cd "$ASF_DIR" && hermes -p "$PM" -z "Do you remember which port ASF's staging hive listens on? One sentence, no tools.") \
  | sed "s/^/  $PM: /"
read -r Q_EP flagged <<<"$(last_turn "$M_ID")"
[ "$Q_EP" != "$M_EP" ] || fail "no turn episode for the question"
[ "$flagged" = false ] || fail "question turn $Q_EP was flagged as a remember request"
settle "$M_ID"
[ -z "$(psql_ "select id from distill_jobs where episode_id = '$Q_EP'")" ] || fail "question turn $Q_EP has a distill job"
q_facts=$(psql_ "select id from facts where recorded_at >= '$Q_START'
                 and (author_instance_id = '$M_ID' or id in (select fact_id from anchors where episode_id = '$Q_EP'))")
[ -z "$q_facts" ] || fail "the question made facts: $q_facts"

agent() { [ "$1" = t ] && echo "yes, deduped into it" || echo no; }
cat <<EOF

==== e2e-remember summary ($(date -u +%Y-%m-%dT%H:%MZ)) ====
curator       turn $C_EP -> one active asked fact ${C_FACT:0:8} (port $C_PORT) in ${C_S}s; agent's hive_remember first: $(agent "$C_AGENT")
member        turn $M_EP -> one asked candidate ${M_FACT:0:8} (port $M_PORT) in ${M_S}s, #$M_POS in the queue; agent's hive_remember first: $(agent "$M_AGENT")
question      turn $Q_EP not flagged: no distill job, no fact
OK
EOF
