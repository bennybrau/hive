#!/usr/bin/env bash
# M5 experiment (#20): ask each question in questions.json through `hermes -z` with the Hive memory provider off
# and on, grade every answer against its key with a claude judge, and write results.csv plus the report.
#
#   scripts/experiment/run.sh [--only id,id] [--repeats N] [--seed S] [--out DIR] [--arms off,on[,file]] [--jobs N]
#
# --arms file adds a third arm: no Hive, but run in a worktree whose CLAUDE.md has every fact the on-arm can read
# (active, ASF repo + global) pasted in under "Team knowledge": the hand-kept CLAUDE.md the Hive is compared
# against. All arms run in detached worktrees of ASF_DIR at the same commit. --jobs runs that many sessions at once.
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
usage() { echo "usage: $0 [--only id,id] [--repeats N] [--seed S] [--out DIR] [--arms off,on[,file]] [--jobs N]" >&2; exit 2; }
ONLY="" REPEATS=3 SEED="$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')" OUT="" ARMS="off,on" JOBS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:?}"; shift 2 ;;
    --repeats) REPEATS="${2:?}"; shift 2 ;;
    --seed) SEED="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --arms) ARMS="${2:?}"; shift 2 ;;
    --jobs) JOBS="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$REPEATS" =~ ^[1-9][0-9]*$ ]] || usage
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || usage
[[ "$ARMS" =~ ^(off|on|file)(,(off|on|file))*$ ]] || usage
URL="http://127.0.0.1:${HIVE_PORT:-8800}"
ASF_DIR="${ASF_DIR:-$HOME/dev/agentic-software-factory}"
DISTILL_TIMEOUT="${EXP_DISTILL_TIMEOUT:-600}"
QUESTIONS=scripts/experiment/questions.json
# unique per run: a multiplexed gateway writes logs/ into every profile it has seen, so a fixed name can't be re-created
STAMP="$(date +%Y%m%d%H%M%S)"
POFF=hive-exp-off-$STAMP PON=hive-exp-on-$STAMP PFILE=hive-exp-file-$STAMP
export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-${CLAUDE_OAUTH_TOKEN:-}}"

[ -d "$ASF_DIR/.git" ] || { echo "no ASF checkout at $ASF_DIR (set ASF_DIR)" >&2; exit 1; }
command -v hermes >/dev/null || { echo "hermes is not on PATH" >&2; exit 1; }
curl -fsS "$URL/health" >/dev/null || { echo "the hive isn't answering at $URL (scripts/redeploy.sh)" >&2; exit 1; }
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) for the judge" >&2; exit 1; }

OUT="${OUT:-scripts/experiment/results/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT/runs"
OUT="$(cd "$OUT" && pwd)"
echo "$SEED" > "$OUT/seed"
python3 - "$QUESTIONS" "$ONLY" "$REPEATS" "$SEED" "$ARMS" > "$OUT/plan.tsv" <<'EOF'
import json, random, sys
path, only, repeats, seed, arms = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5].split(",")
ids = [q["id"] for q in json.load(open(path))["questions"]]
want = only.split(",") if only else ids
unknown = [i for i in want if i not in ids]
if unknown: sys.exit(f"unknown question id(s): {', '.join(unknown)}")
plan = [(q, arm, r) for q in want for arm in arms for r in range(1, repeats + 1)]
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
  # `profile delete` first, so a gateway that serves the profiles lets go of them; rm -rf alone gets them re-created
  for name in "$POFF" "$PON" "$PFILE"; do
    herm profile delete -y "$name" >/dev/null 2>&1
    rm -rf "$HOME/.hermes/profiles/$name"
  done
  for wt in "$WT_BASE" "$WT_FILE"; do [ -n "$wt" ] && git -C "$ASF_DIR" worktree remove --force "$wt" 2>/dev/null; done
  [ -n "$WT_ROOT" ] && rm -rf "$WT_ROOT"
}
WT_ROOT="" WT_BASE="" WT_FILE=""
trap cleanup EXIT

echo "== setup"
read -r ON_ID ON_TOK <<<"$(docker compose exec -T hive node dist/cli/mint-token.js --name "$PON-$(date +%Y%m%d%H%M%S)-$RANDOM" \
  --user "$PON" --role member --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"], d["token"])')"
for name in "$POFF" "$PON" "$PFILE"; do
  dir="$HOME/.hermes/profiles/$name"
  rm -rf "$dir"
  herm profile create "$name" --clone --no-alias --description "throwaway: hive experiment" >/dev/null
  rm -f "$dir/plugins/hive"   # the default profile may have the Hive set up; start both arms without it
  if [ -f "$dir/.env" ]; then (umask 077; grep -v '^HIVE_' "$dir/.env" > "$dir/.env.tmp" || true); mv "$dir/.env.tmp" "$dir/.env"; fi
done
for name in "$POFF" "$PFILE"; do
  herm -p "$name" config set memory.provider "" >/dev/null
  status=$(herm -p "$name" memory status 2>&1)
  case "${status//$name/}" in *hive*|*Hive*) echo "$status"; fail "$name still shows the hive" ;; esac
done
mkdir -p "$HOME/.hermes/profiles/$PON/plugins" && ln -sfn "$PWD/plugins/hive" "$HOME/.hermes/profiles/$PON/plugins/hive"
# HIVE_REPO_KEY: under a gateway-served CLI the plugin's own detection (git remote of os.getcwd()) sees the gateway's
# directory, not the caller's, so no repo is found, no brief is sent and recall is unscoped. Name the repo outright.
REPO_KEY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["repo_key"])' "$QUESTIONS")"
(umask 077; printf 'HIVE_URL=%s\nHIVE_TOKEN=%s\nHIVE_REPO_KEY=%s\n' "$URL" "$ON_TOK" "$REPO_KEY" >> "$HOME/.hermes/profiles/$PON/.env")
herm -p "$PON" config set memory.provider hive >/dev/null
status=$(herm -p "$PON" memory status 2>&1)   # no `| grep -q`: early exit + pipefail = false failure
case "$status" in *"available ✓"*) ;; *) echo "$status"; fail "plugin not available in $PON" ;; esac

# every arm runs in a detached worktree of ASF_DIR at one commit; the file arm's has the Hive's facts in CLAUDE.md
SHA="$(git -C "$ASF_DIR" rev-parse --short "${ASF_REF:-origin/main}")"
WT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/hive-exp-wt.XXXXXX")"
WT_BASE="$WT_ROOT/base" WT_FILE="$WT_ROOT/file"
git -C "$ASF_DIR" worktree add -q --detach "$WT_BASE" "$SHA"
git -C "$ASF_DIR" worktree add -q --detach "$WT_FILE" "$SHA"
echo "$SHA" > "$OUT/asf_commit"
{
  printf '\n## Team knowledge\n\nDecisions, conventions and gotchas the team has agreed. Kept by hand.\n\n'
  psql_ "select '- **' || kind || ':** ' || replace(text, E'\n', ' ') from facts
         where status = 'active' and scope in ('repo:gh/bennybrau/agentic-software-factory', 'global')
         order by kind, recorded_at"
} > "$OUT/team-knowledge.md"
cat "$OUT/team-knowledge.md" >> "$WT_FILE/CLAUDE.md"
echo "  ASF $SHA; file arm: CLAUDE.md $(wc -c < "$WT_BASE/CLAUDE.md") -> $(wc -c < "$WT_FILE/CLAUDE.md") chars ($(grep -c '^- \*\*' "$OUT/team-knowledge.md") facts)"

# Canaries: each arm must really differ the way it claims to, or the comparison means nothing.
echo "== canaries"
mkdir -p "$OUT/canary"
hive_calls() { docker compose logs hive --since "$1" 2>/dev/null | grep -c "\"method\":\"$2\",\"url\":\"$3" || true; }
canary() {   # profile dir question -> answer on stdout
  (cd "$2" && herm -p "$1" -z "$3") < /dev/null
}
FIRST_FACT="$(grep -m1 '^- \*\*' "$OUT/team-knowledge.md" | sed -E 's/^- \*\*[a-z]+:\*\* //' | cut -c1-40)"
ASK_FILE="Do not use any tools. Look only at the project context you were given at the start. Is there a section headed 'Team knowledge'? If yes, quote its first bullet word for word. If no, say NO SUCH SECTION."
if [[ ",$ARMS," == *,file,* ]]; then
  canary "$PFILE" "$WT_FILE" "$ASK_FILE" > "$OUT/canary/file.txt" || fail "file canary: hermes failed"
  grep -qF "$FIRST_FACT" "$OUT/canary/file.txt" || fail "file canary: the session did not see the Team knowledge section of CLAUDE.md (canary/file.txt)"
  echo "  file: the session quotes the Team knowledge section from CLAUDE.md"
fi
if [[ ",$ARMS," == *,off,* ]]; then
  canary "$POFF" "$WT_BASE" "$ASK_FILE" > "$OUT/canary/off.txt" || fail "off canary: hermes failed"
  grep -qF "$FIRST_FACT" "$OUT/canary/off.txt" && fail "off canary: the off arm sees the Team knowledge section (canary/off.txt)"
  echo "  off: no Team knowledge section in context"
fi
if [[ ",$ARMS," == *,on,* ]]; then
  T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  canary "$PON" "$WT_BASE" "Do not use any tools. Reply with the heading line of any Hive block in your context, or NO HIVE BLOCK." > "$OUT/canary/on.txt" || fail "on canary: hermes failed"
  sleep 2
  [ "$(hive_calls "$T0" POST /v1/brief)" -ge 1 ] || fail "on canary: the session sent no POST /v1/brief (repo not detected?)"
  grep -q "Hive brief" "$OUT/canary/on.txt" || fail "on canary: no Hive brief block reached the session (canary/on.txt)"
  echo "  on: the session got a Hive brief for $REPO_KEY"
fi
RUNS_T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== runs"
one_run() {   # qid arm run
  local qid=$1 arm=$2 run=$3 base="$OUT/runs/$1.$2.$3" profile dir question
  case "$arm" in on) profile=$PON dir=$WT_BASE ;; off) profile=$POFF dir=$WT_BASE ;; file) profile=$PFILE dir=$WT_FILE ;; esac
  question=$(python3 -c 'import json,sys; print(next(q["question"] for q in json.load(open(sys.argv[1]))["questions"] if q["id"] == sys.argv[2]))' "$QUESTIONS" "$qid")
  (cd "$dir" && herm -p "$profile" -z "$question" --usage-file "$base.usage.json") < /dev/null > "$base.answer.txt" \
    || { echo "FAIL: hermes failed on $qid $arm $run" >&2; return 1; }
  echo "  $qid $arm $run  $(python3 -c 'import json,sys; u=json.load(open(sys.argv[1])); print("model=%s cost=%s" % (u.get("model") or "?", u.get("estimated_cost_usd")))' "$base.usage.json")"
}
export -f one_run herm
export OUT QUESTIONS PON POFF PFILE WT_BASE WT_FILE
tr '\t' ' ' < "$OUT/plan.tsv" | xargs -P "$JOBS" -L 1 bash -c 'one_run "$@"' _ || fail "some runs failed"
if [[ ",$ARMS," == *,on,* ]]; then
  on_runs=$(grep -c "$(printf '\ton\t')" "$OUT/plan.tsv")
  briefs=$(hive_calls "$RUNS_T0" POST /v1/brief)
  echo "  on arm: $briefs briefs for $on_runs sessions"
  [ "$briefs" -ge "$on_runs" ] || fail "only $briefs briefs for $on_runs on-arm sessions: the on arm did not run as designed"
fi
models=$(python3 -c 'import json,glob,sys; print(" ".join(sorted({json.load(open(f)).get("model") or "?" for f in glob.glob(sys.argv[1] + "/runs/*.usage.json")})))' "$OUT")
[ "$(wc -w <<<"$models")" -eq 1 ] || fail "the arms ran on different models ($models): they must use the same one"

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
