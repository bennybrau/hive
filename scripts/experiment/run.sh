#!/usr/bin/env bash
# M5 experiment (#20): ask each question in questions.json through `hermes -z` with the Hive memory provider off
# and on, grade every answer against its key with a claude judge, and write results.csv plus the report.
#
#   scripts/experiment/run.sh [--only id,id] [--repeats N] [--seed S] [--out DIR]
#
# --repeats (default 3) runs of each question per arm, in an order shuffled with --seed (default random; recorded
# in DIR/seed). --out defaults to scripts/experiment/results/<utc-ts>/ (git-ignored). Both arms use throwaway
# profiles cloned from your default Hermes profile (same model, both run in ASF_DIR): hive-exp-off has no memory
# provider, no hive plugin and no HIVE_* env; hive-exp-on has the plugin and a member token minted here. The run
# aborts if the two arms report different models. Afterwards it waits for the on-arm's distills, dumps llm_calls
# for the run window, and deletes the experiment's episodes, jobs and facts (llm_calls kept, token revoked).
#
# Needs what e2e-distill.sh needs (the stack via scripts/redeploy.sh with the hive-worker, `hermes` on PATH, an ASF
# checkout at ASF_DIR, default ~/dev/agentic-software-factory) plus CLAUDE_CODE_OAUTH_TOKEN (or CLAUDE_OAUTH_TOKEN)
# for the judge, which runs in the hive-worker image (HIVE_EXPERIMENT_JUDGE_MODEL, default claude-sonnet-5-5).
# EXP_DISTILL_TIMEOUT (default 600) is the seconds to wait for the on-arm's distill jobs. See README.md for cost.
set -euo pipefail
cd "$(dirname "$0")/../.."
usage() { echo "usage: $0 [--only id,id] [--repeats N] [--seed S] [--out DIR]" >&2; exit 2; }
ONLY="" REPEATS=3 SEED="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')" OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:?}"; shift 2 ;;
    --repeats) REPEATS="${2:?}"; shift 2 ;;
    --seed) SEED="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$REPEATS" =~ ^[1-9][0-9]*$ ]] || usage
URL="http://127.0.0.1:${HIVE_PORT:-8800}"
ASF_DIR="${ASF_DIR:-$HOME/dev/agentic-software-factory}"
DISTILL_TIMEOUT="${EXP_DISTILL_TIMEOUT:-600}"
QUESTIONS=scripts/experiment/questions.json
POFF=hive-exp-off PON=hive-exp-on
export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-${CLAUDE_OAUTH_TOKEN:-}}"

[ -d "$ASF_DIR/.git" ] || { echo "no ASF checkout at $ASF_DIR (set ASF_DIR)" >&2; exit 1; }
command -v hermes >/dev/null || { echo "hermes is not on PATH" >&2; exit 1; }
curl -fsS "$URL/health" >/dev/null || { echo "the hive isn't answering at $URL (scripts/redeploy.sh)" >&2; exit 1; }
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) for the judge" >&2; exit 1; }

OUT="${OUT:-scripts/experiment/results/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT/runs"
OUT="$(cd "$OUT" && pwd)"
echo "$SEED" > "$OUT/seed"
python3 - "$QUESTIONS" "$ONLY" "$REPEATS" "$SEED" > "$OUT/plan.tsv" <<'EOF'
import json, random, sys
path, only, repeats, seed = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
ids = [q["id"] for q in json.load(open(path))["questions"]]
want = only.split(",") if only else ids
unknown = [i for i in want if i not in ids]
if unknown: sys.exit(f"unknown question id(s): {', '.join(unknown)}")
plan = [(q, arm, r) for q in want for arm in ("off", "on") for r in range(1, repeats + 1)]
random.Random(seed).shuffle(plan)
for q, arm, r in plan: print(f"{q}\t{arm}\t{r}")
EOF
echo "== $(wc -l < "$OUT/plan.tsv") runs, seed $SEED, out $OUT"

psql_() { docker compose exec -T postgres psql -U hive -d hive -v ON_ERROR_STOP=1 -tAq -c "$1"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# hermes without any HIVE_* from this shell: the off arm gets none, the on arm only its profile's .env
herm() { (unset $(compgen -e -X '!HIVE_*'); hermes "$@"); }

ON_ID=""
START_AT="$(psql_ "select now()")"
cleanup() {
  set +e
  echo "== cleanup"
  if [ -n "$ON_ID" ]; then
    psql_ "begin;
      create temp table exp_eps on commit drop as select id from episodes where instance_id = '$ON_ID';
      update llm_calls set episode_id = null where episode_id in (select id from exp_eps);
      create temp table exp_facts on commit drop as select id from facts
        where recorded_at >= '$START_AT' and (author_instance_id = '$ON_ID'
          or id in (select fact_id from anchors where episode_id in (select id from exp_eps)));
      update facts set supersedes = null where supersedes in (select id from exp_facts);
      delete from reviews where fact_id in (select id from exp_facts);
      delete from facts where id in (select id from exp_facts);
      delete from anchors where episode_id in (select id from exp_eps);
      delete from distill_jobs where episode_id in (select id from exp_eps);
      delete from episodes where id in (select id from exp_eps);
      update instances set revoked_at = now() where id = '$ON_ID' and revoked_at is null;
      commit;" >/dev/null && echo "  experiment facts, jobs, episodes deleted; token revoked (llm_calls kept)"
  fi
  rm -rf "$HOME/.hermes/profiles/$POFF" "$HOME/.hermes/profiles/$PON"
}
trap cleanup EXIT

echo "== setup"
read -r ON_ID ON_TOK <<<"$(docker compose exec -T hive node dist/cli/mint-token.js --name "$PON-$(date +%Y%m%d%H%M%S)-$RANDOM" \
  --user "$PON" --role member --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"], d["token"])')"
for name in "$POFF" "$PON"; do
  dir="$HOME/.hermes/profiles/$name"
  rm -rf "$dir"
  herm profile create "$name" --clone --no-alias --description "throwaway: hive experiment" >/dev/null
  rm -f "$dir/plugins/hive"   # the default profile may have the Hive set up; start both arms without it
  if [ -f "$dir/.env" ]; then (umask 077; grep -v '^HIVE_' "$dir/.env" > "$dir/.env.tmp" || true); mv "$dir/.env.tmp" "$dir/.env"; fi
done
herm -p "$POFF" config set memory.provider "" >/dev/null
status=$(herm -p "$POFF" memory status 2>&1)
case "${status//$POFF/}" in *hive*|*Hive*) echo "$status"; fail "$POFF still shows the hive" ;; esac
mkdir -p "$HOME/.hermes/profiles/$PON/plugins" && ln -sfn "$PWD/plugins/hive" "$HOME/.hermes/profiles/$PON/plugins/hive"
(umask 077; printf 'HIVE_URL=%s\nHIVE_TOKEN=%s\n' "$URL" "$ON_TOK" >> "$HOME/.hermes/profiles/$PON/.env")
herm -p "$PON" config set memory.provider hive >/dev/null
status=$(herm -p "$PON" memory status 2>&1)   # no `| grep -q`: early exit + pipefail = false failure
case "$status" in *"available ✓"*) ;; *) echo "$status"; fail "plugin not available in $PON" ;; esac

echo "== runs"
MODEL=""
i=0
while IFS=$'\t' read -r qid arm run; do
  i=$((i + 1))
  base="$OUT/runs/$qid.$arm.$run"
  profile=$([ "$arm" = on ] && echo "$PON" || echo "$POFF")
  question=$(python3 -c 'import json,sys; print(next(q["question"] for q in json.load(open(sys.argv[1]))["questions"] if q["id"] == sys.argv[2]))' "$QUESTIONS" "$qid")
  (cd "$ASF_DIR" && herm -p "$profile" -z "$question" --usage-file "$base.usage.json") < /dev/null > "$base.answer.txt" \
    || fail "hermes failed on $qid $arm $run"
  read -r model cost <<<"$(python3 -c 'import json,sys; u=json.load(open(sys.argv[1])); print(u.get("model") or "?", u.get("estimated_cost_usd"))' "$base.usage.json")"
  [ -z "$MODEL" ] && MODEL="$model"
  [ "$model" = "$MODEL" ] || fail "$qid $arm $run ran on $model, earlier runs on $MODEL: the arms must use the same model"
  echo "  [$i] $qid $arm $run  model=$model cost=$cost"
done < "$OUT/plan.tsv"

echo "== waiting for the on-arm's distill jobs"
waited=0
while :; do
  left=$(psql_ "select count(*) from distill_jobs j join episodes e on e.id = j.episode_id
                where e.instance_id = '$ON_ID' and j.status in ('queued', 'claimed')")
  [ "$left" = 0 ] && break
  [ "$waited" -lt "$DISTILL_TIMEOUT" ] || fail "$left distill jobs still pending after ${DISTILL_TIMEOUT}s (EXP_DISTILL_TIMEOUT)"
  sleep 5; waited=$((waited + 5))
done
psql_ "copy (select * from llm_calls where created_at >= '$START_AT' order by created_at) to stdout with csv header" > "$OUT/llm_calls.csv"
echo "  $(($(wc -l < "$OUT/llm_calls.csv") - 1)) llm_calls since $START_AT -> llm_calls.csv"

echo "== judge"
chmod a+w "$OUT"   # the container writes judge.jsonl as its own user (node)
docker compose build -q hive-worker
docker compose run --rm --no-deps -T -e CLAUDE_CODE_OAUTH_TOKEN -e HIVE_EXPERIMENT_JUDGE_MODEL \
  -v "$PWD/$QUESTIONS:/exp/questions.json:ro" -v "$OUT:/exp/out" \
  hive-worker node dist/experiment/judge.js --questions /exp/questions.json --dir /exp/out

python3 - "$OUT" <<'EOF'
import csv, json, os, re, sys
out = sys.argv[1]
judged = {(j["question"], j["arm"], str(j["run"])): j for j in map(json.loads, open(os.path.join(out, "judge.jsonl")))}
cols = ["question", "arm", "run", "model", "api_calls", "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_write_tokens", "est_cost_usd", "correct", "judge_notes", "manual", "cited_fact_ids"]
with open(os.path.join(out, "results.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(cols)
    for line in open(os.path.join(out, "plan.tsv")):
        q, arm, run = line.rstrip("\n").split("\t")
        base = os.path.join(out, "runs", f"{q}.{arm}.{run}")
        u = json.load(open(base + ".usage.json"))
        answer = open(base + ".answer.txt").read()
        j = judged[q, arm, run]
        cited = sorted(set(re.findall(r"\[hive:([0-9a-f]{8})\]", answer)))
        w.writerow([q, arm, run, u.get("model", ""), u.get("api_calls", ""), u.get("input_tokens", 0), u.get("output_tokens", 0),
                    u.get("cache_read_tokens", 0), u.get("cache_write_tokens", 0), u.get("estimated_cost_usd", ""),
                    int(j["correct"]), j["notes"], "", " ".join(cited)])
EOF
echo "== results.csv in $OUT"
echo
python3 scripts/experiment/report.py "$OUT"
