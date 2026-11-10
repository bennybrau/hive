#!/usr/bin/env bash
# Prove docker-compose.release.yml runs with no checkout: copy it alone into an empty temp dir, run it on locally
# built images under a throwaway project, wait for every service to be healthy, and hit /health. Also asserts the
# file has no build:/./ mounts and both images run as non-root with a built-in HEALTHCHECK.
#   scripts/test-release.sh            # builds hive:ci and hive-worker:ci if they don't exist yet
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
HIVE_SRC="${HIVE_SRC_IMAGE:-hive:ci}"
WORKER_SRC="${WORKER_SRC_IMAGE:-hive-worker:ci}"
TAG=release-test
PROJECT="hive-release-test-$$"   # never the real `hive` project
PORT="${HIVE_RELEASE_TEST_PORT:-18800}"
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- the file itself ---------------------------------------------------------
grep -nE '^\s*build:' docker-compose.release.yml && fail "release compose has a build: key"
grep -nE '^\s*-\s*["'\'']?\.\.?/' docker-compose.release.yml && fail "release compose mounts a path from the checkout"

# --- the images --------------------------------------------------------------
docker image inspect "$HIVE_SRC" >/dev/null 2>&1 || docker build -f apps/hive/Dockerfile -t "$HIVE_SRC" .
docker image inspect "$WORKER_SRC" >/dev/null 2>&1 || docker build -f apps/worker/Dockerfile -t "$WORKER_SRC" .
for img in "$HIVE_SRC" "$WORKER_SRC"; do
  user="$(docker image inspect --format '{{.Config.User}}' "$img")"
  case "$user" in ""|root|0|0:*|root:*) fail "$img runs as root (USER='${user}')" ;; esac
  [ -n "$(docker image inspect --format '{{if .Config.Healthcheck}}{{.Config.Healthcheck.Test}}{{end}}' "$img")" ] \
    || fail "$img has no HEALTHCHECK"
done
docker tag "$HIVE_SRC" "ghcr.io/bennybrau/hive:${TAG}"
docker tag "$WORKER_SRC" "ghcr.io/bennybrau/hive-worker:${TAG}"

# --- run it from an empty dir ------------------------------------------------
DIR="$(mktemp -d)"
cp docker-compose.release.yml "$DIR/docker-compose.yml"
cat > "$DIR/.env" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
HIVE_SECRET_KEY=$(openssl rand -hex 32)
HIVE_VERSION=${TAG}
HIVE_PORT=${PORT}
OLLAMA_URL=
EOF
dc() { docker compose --project-directory "$DIR" -p "$PROJECT" "$@"; }
cleanup() {
  dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker rmi "ghcr.io/bennybrau/hive:${TAG}" "ghcr.io/bennybrau/hive-worker:${TAG}" >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT
cd "$DIR"

grep -q '"build"' <<<"$(dc config --format json)" && fail "resolved release compose has a build section"
dc up --detach --wait --wait-timeout 180 || { dc ps; dc logs --tail 50; fail "stack did not become healthy"; }
HEALTH="$(curl -fsS "http://127.0.0.1:${PORT}/health")" || fail "/health unreachable"
echo "health: ${HEALTH}"
grep -q '"ok":true' <<<"$HEALTH" || fail "/health not ok"
# worker idles without a token and says so as a JSON log line
WLOG="$(dc logs --no-log-prefix hive-worker)"
grep -m1 '^{' <<<"$WLOG" | node -e \
  'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(typeof l.level==="number"&&l.msg?0:1)' \
  || fail "worker log is not JSON lines"
cd "$ROOT"
echo "release compose ok"
