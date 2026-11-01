#!/usr/bin/env bash
# Distill eval: run the hive-worker's distill over the labelled transcripts in scripts/eval-distill/cases and
# print found / false positives / quote validity / tokens / cost per case, totals and the targets.
#
#   scripts/eval-distill.sh [--only id,id] [--repeat N] [--concurrency N] [--threshold 0.85]
#
# Runs inside the hive-worker image (built here), so it needs only Docker. The prompt directory is mounted, so
# edits to apps/worker/prompts/distill.md are evaluated without a rebuild. Needs:
#   CLAUDE_CODE_OAUTH_TOKEN (or CLAUDE_OAUTH_TOKEN): a `claude setup-token` subscription token, passed by name
#     only, never on the command line. A full run costs about $1.50 (distill plus judge).
#   A claude judge (same token; HIVE_EVAL_JUDGE_MODEL to change it) matches proposed facts to the labels.
# Exit 0 when every target passes, 1 when one fails, 2 on error. A JSON copy goes to scripts/eval-distill/results/.
set -euo pipefail
cd "$(dirname "$0")/.."

export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-${CLAUDE_OAUTH_TOKEN:-}}"
if [[ -z "$CLAUDE_CODE_OAUTH_TOKEN" && "${HIVE_DISTILL_RUNNER:-claude}" == claude ]]; then
  echo "set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) first" >&2
  exit 2
fi

mkdir -p scripts/eval-distill/results
chmod a+w scripts/eval-distill/results   # the container writes as its own user (node)
out="results/$(date -u +%Y%m%dT%H%M%SZ).json"
docker compose build -q hive-worker
docker compose run --rm --no-deps -T \
  -e CLAUDE_CODE_OAUTH_TOKEN \
  -e HIVE_DISTILL_RUNNER -e HIVE_DISTILL_MODEL -e HIVE_EVAL_JUDGE_MODEL \
  -v "$PWD/scripts/eval-distill/cases:/eval/cases:ro" \
  -v "$PWD/scripts/eval-distill/results:/eval/results" \
  -v "$PWD/apps/worker/prompts:/app/prompts:ro" \
  hive-worker node dist/eval/run.js --cases /eval/cases --json "/eval/$out" "$@"
