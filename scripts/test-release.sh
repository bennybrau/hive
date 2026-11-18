#!/usr/bin/env bash
# Prove docker-compose.release.yml runs with no checkout: copy it alone into an empty temp dir, run it on locally
# built images under a throwaway project, wait for every service to be healthy, and hit /health. Also asserts the
# file has no build:/./ mounts, both images run as non-root with a built-in HEALTHCHECK, and /health reports the
# HIVE_VERSION baked into the image.
#   scripts/test-release.sh            # builds hive:release-test (cheap on top of hive:ci's cache); builds
#                                      # hive-worker:ci if it doesn't exist yet
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORKER_SRC="${WORKER_SRC_IMAGE:-hive-worker:ci}"
TAG=release-test
PROJECT="hive-release-test-$$"   # never the real `hive` project
PORT="${HIVE_RELEASE_TEST_PORT:-18800}"
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- the file itself ---------------------------------------------------------
grep -nE '^\s*build:' docker-compose.release.yml && fail "release compose has a build: key"
grep -nE '^\s*-\s*["'\'']?\.\.?/' docker-compose.release.yml && fail "release compose mounts a path from the checkout"

# --- the images --------------------------------------------------------------
# Always built with the version arg: an existing hive:ci was built without it and would report `dev`.
docker build -f apps/hive/Dockerfile --build-arg HIVE_VERSION="$TAG" -t "hive:${TAG}" .
docker image inspect "$WORKER_SRC" >/dev/null 2>&1 || docker build -f apps/worker/Dockerfile -t "$WORKER_SRC" .
docker tag "$WORKER_SRC" "hive-worker:${TAG}"
for img in "hive:${TAG}" "hive-worker:${TAG}"; do
  user="$(docker image inspect --format '{{.Config.User}}' "$img")"
  case "$user" in ""|root|0|0:*|root:*) fail "$img runs as root (USER='${user}')" ;; esac
  [ -n "$(docker image inspect --format '{{if .Config.Healthcheck}}{{.Config.Healthcheck.Test}}{{end}}' "$img")" ] \
    || fail "$img has no HEALTHCHECK"
done

# --- run it from an empty dir ------------------------------------------------
DIR="$(mktemp -d)"
cp docker-compose.release.yml "$DIR/docker-compose.yml"
cat > "$DIR/.env" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
HIVE_SECRET_KEY=$(openssl rand -hex 32)
HIVE_IMAGE=hive
HIVE_WORKER_IMAGE=hive-worker
HIVE_VERSION=${TAG}
HIVE_PORT=${PORT}
OLLAMA_URL=
EOF
dc() { docker compose --project-directory "$DIR" -p "$PROJECT" "$@"; }
cleanup() {
  dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker rmi "hive:${TAG}" "hive-worker:${TAG}" >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT
cd "$DIR"

grep -q '"build"' <<<"$(dc config --format json)" && fail "resolved release compose has a build section"
dc up --detach --wait --wait-timeout 180 || { dc ps; dc logs --tail 50; fail "stack did not become healthy"; }
HEALTH="$(curl -fsS "http://127.0.0.1:${PORT}/health")" || fail "/health unreachable"
echo "health: ${HEALTH}"
grep -q '"ok":true' <<<"$HEALTH" || fail "/health not ok"
node -e 'process.exit(JSON.parse(process.argv[1]).version===process.argv[2]?0:1)' "$HEALTH" "$TAG" \
  || fail "/health version is not ${TAG}"
# worker idles without a token and says so as a JSON log line
WLOG="$(dc logs --no-log-prefix hive-worker)"
grep -m1 '^{' <<<"$WLOG" | node -e \
  'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(typeof l.level==="number"&&l.msg?0:1)' \
  || fail "worker log is not JSON lines"

# --- the restore drill: a row, a backup, restore.sh into a new db, the counts match ---------------
dc exec -T postgres psql -U hive -d hive -v ON_ERROR_STOP=1 -c \
  "insert into instances (name, user_id, token_hash) values ('release-test', 'release-test', 'release-test-hash')" \
  || fail "cannot seed an instance"
dc run --rm --no-deps -T backup once || fail "backup once failed"
DRILL="$("$ROOT/scripts/restore.sh" latest --dir "$DIR" --project "$PROJECT")" || { echo "$DRILL"; fail "restore.sh failed"; }
echo "$DRILL"
for t in facts episodes anchors instances; do
  grep -qE "^${t} +([0-9]+) +\\1$" <<<"$DRILL" || fail "restore drill: ${t} restored != live"
done
grep -qE '^instances +[1-9]' <<<"$DRILL" || fail "restore drill: the seeded instance was not restored"
cd "$ROOT"
echo "release compose ok"
