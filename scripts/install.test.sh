#!/usr/bin/env bash
# Tests for scripts/install.sh. No Docker or network needed.
#
#   bash scripts/install.test.sh
#
# Fake `docker`, `curl`, `uname` and `hermes` on PATH log their argv to $FAKE_LOG and serve canned answers, steered by
# FAKE_* env vars (see the fakes below). Every case installs into its own temp HIVE_HOME.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SH="$REPO_ROOT/scripts/install.sh"

PASS=0
FAIL=0
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }
assert_contains() { case "$1" in *"$2"*) pass ;; *) fail "$3 (expected to find: $2)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "$3 (did not expect to find: $2)" ;; *) pass ;; esac; }
assert_eq() { [ "$1" = "$2" ] && pass || fail "$3 (got '$1', want '$2')"; }
assert_file() { [ -e "$1" ] && pass || fail "$2 (missing: $1)"; }
assert_no_file() { [ -e "$1" ] && fail "$2 (exists: $1)" || pass; }

TMP="$(cd "$(mktemp -d)" && pwd)"   # clean, as install.sh cleans HIVE_HOME (macOS $TMPDIR ends in /)
FAKE_BIN="$TMP/bin"
NODOCKER_BIN="$TMP/nodocker"   # /usr/bin + /bin + the fakes, minus docker (CI runners keep docker in /usr/bin)
mkdir -p "$FAKE_BIN" "$NODOCKER_BIN"
trap 'rm -rf "$TMP"' EXIT
export FAKE_LOG="$TMP/argv.log" FAKE_STDIN="$TMP/stdin.log"

# docker: FAKE_INFO_FAIL=1 (daemon down), FAKE_COMPOSE_V1=1 (no compose v2), FAKE_OS (docker info --format),
# FAKE_VOLUMES (existing volume names), FAKE_PS_PROJECT + FAKE_PS_WORKDIR (a project's containers),
# FAKE_CURATORS (live curator count), FAKE_USERS (users that already have a token), FAKE_PS_HEALTH (every service's
# health in `docker compose ps`, default healthy), FAKE_PS_FAIL=1 (`docker ps` fails), FAKE_PULL_FAIL=1 (`compose pull`
# fails), FAKE_IMAGES (images `image inspect` finds; `compose config --images` prints hive's two at $HIVE_VERSION),
# FAKE_BACKUP_NEWEST (what `run ... backup newest` prints; default a 1 h old dump, `fail` = it exits 1).
cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  image)
    for i in ${FAKE_IMAGES:-}; do [ "$3" = "$i" ] && exit 0; done
    exit 1 ;;
  info)
    [ "${FAKE_INFO_FAIL:-}" = 1 ] && exit 1
    [ "${2:-}" = "--format" ] && echo "${FAKE_OS:-Ubuntu 24.04 LTS testhost}"
    exit 0 ;;
  volume)
    for v in ${FAKE_VOLUMES:-}; do [ "$3" = "$v" ] && exit 0; done
    exit 1 ;;
  ps)
    [ "${FAKE_PS_FAIL:-}" = 1 ] && { echo "permission denied while trying to connect to the Docker daemon" >&2; exit 1; }
    case "$*" in *"label=com.docker.compose.project=${FAKE_PS_PROJECT:-none} "*)
      case "$*" in *"-q"*) echo abc123 ;; *) echo "${FAKE_PS_WORKDIR:-}" ;; esac ;;
    esac
    exit 0 ;;
  compose)
    [ "${2:-}" = "version" ] && { [ "${FAKE_COMPOSE_V1:-}" = 1 ] && exit 1; echo "Docker Compose version v2.99.9"; exit 0; }
    case "$*" in
      *mint-token.js*)
        user=""; role=""; prev=""
        for a in "$@"; do
          [ "$prev" = "--user" ] && user=$a
          [ "$prev" = "--role" ] && role=$a
          prev=$a
        done
        echo "{\"id\":\"x\",\"name\":\"n\",\"user_id\":\"$user\",\"role\":\"$role\",\"token\":\"tok-$user-$role\"}" ;;
      *" pull"*) [ "${FAKE_PULL_FAIL:-}" = 1 ] && exit 1 ;;
      *"run --rm --no-deps -T backup newest"*)
        [ "${FAKE_BACKUP_NEWEST:-}" = fail ] && { echo "no such service: backup" >&2; exit 1; }
        echo "${FAKE_BACKUP_NEWEST:-3600 hive-20261117-0300.dump}" ;;
      *"config --images"*) echo "ghcr.io/bennybrau/hive:${HIVE_VERSION:-}"; echo "ghcr.io/bennybrau/hive-worker:${HIVE_VERSION:-}" ;;
      *" ps "*) for s in postgres hive hive-worker; do echo "$s running ${FAKE_PS_HEALTH:-healthy}"; done ;;
      *"psql"*"role='curator'"*) echo "${FAKE_CURATORS:-0}" ;;
      *"psql"*"user_id="*)
        n=0; for u in ${FAKE_USERS:-}; do case "$*" in *"user_id='$u'"*) n=1 ;; esac; done; echo "$n" ;;
      *"psql"*) echo 0 ;;
    esac
    exit 0 ;;
esac
exit 0
EOF

# curl: FAKE_OLLAMA=1 (a host Ollama answers), FAKE_NO_GITHUB=1 (no latest release), FAKE_HEALTH_VERSION (/health),
# FAKE_STATUS_CODE (/v1/status, default 200; its body has embeddings state ok). Plugin tarballs come from $FAKE_TARS. Records stdin when the body is read from it.
cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$FAKE_LOG"
out=""; prev=""; url=""; wfmt=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out=$a
  [ "$prev" = "-w" ] && wfmt=$a
  case "$a" in http*) url=$a ;; @-) cat >> "$FAKE_STDIN"; printf '\n' >> "$FAKE_STDIN" ;; esac
  prev=$a
done
case "$url" in
  *api.github.com*) [ "${FAKE_NO_GITHUB:-}" = 1 ] && exit 22; echo '{"tag_name": "v9.9.9"}' ;;
  *:11434*) [ "${FAKE_OLLAMA:-}" = 1 ] || exit 7 ;;
  */health) echo "{\"ok\":true,\"db\":\"up\",\"version\":\"${FAKE_HEALTH_VERSION:-1.2.3}\"}" ;;
  */v1/status) if [ -n "$wfmt" ]; then printf '%s' "${FAKE_STATUS_CODE:-200}"; else echo '{"embeddings":{"state":"ok"}}'; fi ;;
  *hive-plugin.tar.gz) cp "$FAKE_TARS/release.tar.gz" "$out" ;;
  *codeload.github.com*) cp "$FAKE_TARS/codeload.tar.gz" "$out" ;;
  */agent-credential) printf 204 ;;
  *docker-compose.release.yml) printf 'name: hive\n' > "$out" ;;
  *hive.env.example) printf '# example\nPOSTGRES_PASSWORD=\nHIVE_BIND=127.0.0.1\nHIVE_PORT=8800\n' > "$out" ;;
  *install.sh) printf '#!/bin/sh\n' > "$out" ;;
esac
exit 0
EOF

# uname: FAKE_UNAME (default Linux)
cat > "$FAKE_BIN/uname" <<'EOF'
#!/usr/bin/env bash
printf 'uname %s\n' "$*" >> "$FAKE_LOG"
echo "${FAKE_UNAME:-Linux}"
EOF

# hermes: logs its argv and HERMES_HOME; FAKE_HERMES_STATUS is what `hermes memory status` prints.
cat > "$FAKE_BIN/hermes" <<'EOF'
#!/usr/bin/env bash
printf 'hermes %s (HERMES_HOME=%s)\n' "$*" "${HERMES_HOME:-}" >> "$FAKE_LOG"
if [ "$1 $2" = "memory status" ]; then
  printf '%s\n' "${FAKE_HERMES_STATUS:-$(printf 'Memory status\n  Built-in:  on\n  Provider:  hive\n')}"
fi
exit 0
EOF
chmod +x "$FAKE_BIN"/*

# The plugin tarballs: a release's (top dir hive/) and GitHub's repo tarball (hive-<sha>/plugins/hive).
export FAKE_TARS="$TMP/tars"
mkdir -p "$FAKE_TARS/r/hive" "$FAKE_TARS/c/hive-abc1234/plugins/hive"
printf 'name: hive\n' > "$FAKE_TARS/r/hive/plugin.yaml"; echo release > "$FAKE_TARS/r/hive/FROM"
printf 'name: hive\n' > "$FAKE_TARS/c/hive-abc1234/plugins/hive/plugin.yaml"; echo codeload > "$FAKE_TARS/c/hive-abc1234/plugins/hive/FROM"
tar -czf "$FAKE_TARS/release.tar.gz" -C "$FAKE_TARS/r" hive
tar -czf "$FAKE_TARS/codeload.tar.gz" -C "$FAKE_TARS/c" hive-abc1234

for d in /bin /usr/bin "$FAKE_BIN"; do
  for f in "$d"/*; do
    n="${f##*/}"
    case "$n" in docker|docker-*|com.docker*) continue ;; esac
    ln -sf "$f" "$NODOCKER_BIN/$n" 2>/dev/null || true
  done
done

# A free port for the checks (the fake stack never listens).
PORT=18897

CASE=0
new_case() { # a fresh HIVE_HOME and log
  CASE=$((CASE + 1))
  H="$TMP/home$CASE/hive"
  mkdir -p "$TMP/home$CASE"
  : > "$FAKE_LOG"; : > "$FAKE_STDIN"
}
# Non-interactive run with the fakes; the answers come from the environment.
run() {
  ( cd "$TMP" && env HOME="$TMP/home$CASE" USER=alice PATH="$FAKE_BIN:$PATH" HIVE_HOME="$H" HIVE_VERSION=1.2.3 \
      HIVE_PORT="$PORT" HIVE_COMPOSE_SRC= "$@" )
}
get() { # $1 = KEY in $H/.env
  awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2)}' "$H/.env" | tail -1
}
has_key() { grep -q "^$1=" "$H/.env"; }
perm() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# --- --help, unknown option, unknown command ----------------------------------
new_case
out="$(run bash "$INSTALL_SH" --help 2>&1)"; code=$?
assert_eq "$code" "0" "--help exits 0"
assert_contains "$out" "Usage: install.sh" "--help prints usage"
out="$(run bash "$INSTALL_SH" --bogus 2>&1)"; code=$?
assert_eq "$code" "2" "unknown option exits 2"
out="$(run bash "$INSTALL_SH" frobnicate 2>&1)"; code=$?
assert_eq "$code" "2" "unknown command exits 2"

# --- preflight failures: non-zero, nothing written ------------------------------
new_case
out="$(run PATH="$NODOCKER_BIN" HIVE_DISTILL=skip "$NODOCKER_BIN/bash" "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "1" "docker missing => exit 1"
assert_contains "$out" "docker not found" "docker missing => says so"
assert_no_file "$H" "docker missing => no install dir"

new_case
out="$(run FAKE_INFO_FAIL=1 HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "1" "daemon down => exit 1"
assert_contains "$out" "daemon is not reachable" "daemon down => says so"
assert_no_file "$H" "daemon down => no install dir"

new_case
out="$(run FAKE_COMPOSE_V1=1 HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "1" "no compose v2 => exit 1"
assert_contains "$out" "docker compose v2 not available" "no compose v2 => says so"
assert_no_file "$H" "no compose v2 => no install dir"

# --- a required answer missing fails and names the variable ----------------------
new_case
out="$(run HIVE_DISTILL=claude bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "2" "claude without a token => exit 2"
assert_contains "$out" "CLAUDE_CODE_OAUTH_TOKEN" "claude without a token => names the variable"
assert_no_file "$H" "missing answer => no install dir"

new_case
out="$(run HIVE_VERSION= HIVE_DISTILL=skip FAKE_NO_GITHUB=1 bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "2" "no version and no latest release => exit 2"
assert_contains "$out" "HIVE_VERSION" "no version => names HIVE_VERSION"

# --- answers map to .env keys; mode 600; project and self-copy ---------------------
new_case
out="$(run HIVE_BIND=0.0.0.0 HIVE_EMBED=container HIVE_DISTILL=ollama HIVE_DISTILL_MODEL=qwen3 \
  HIVE_REPOS_HOST_ROOT=/srv/repos bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "0" "non-interactive install succeeds"
assert_eq "$(perm "$H/.env")" "600" ".env is mode 600"
assert_eq "$(get HIVE_VERSION)" "1.2.3" "HIVE_VERSION"
assert_eq "$(get HIVE_BIND)" "0.0.0.0" "HIVE_BIND"
assert_eq "$(get HIVE_PORT)" "$PORT" "HIVE_PORT"
assert_eq "$(get HIVE_REPOS_HOST_ROOT)" "/srv/repos" "HIVE_REPOS_HOST_ROOT"
assert_eq "$(get COMPOSE_PROFILES)" "ollama" "embed=container => COMPOSE_PROFILES=ollama"
assert_eq "$(get OLLAMA_URL)" "http://ollama:11434" "embed=container => OLLAMA_URL"
assert_eq "$(get HIVE_DISTILL_RUNNER)" "ollama" "distill=ollama => HIVE_DISTILL_RUNNER"
assert_eq "$(get HIVE_DISTILL_MODEL)" "qwen3" "distill=ollama => HIVE_DISTILL_MODEL"
assert_eq "$(get HIVE_PROJECT)" "hive" "HIVE_PROJECT persisted (default hive)"
pw="$(get POSTGRES_PASSWORD)"; assert_eq "${#pw}" "48" "POSTGRES_PASSWORD generated"
sk="$(get HIVE_SECRET_KEY)"; assert_eq "${#sk}" "64" "HIVE_SECRET_KEY generated"
assert_eq "$(get HIVE_WORKER_TOKEN)" "tok-hive-worker-worker" "worker token minted into .env"
assert_file "$H/install.sh" "install.sh copies itself into the install dir"
cmp -s "$INSTALL_SH" "$H/install.sh" && pass || fail "the copy is the script itself"
assert_file "$H/docker-compose.yml" "compose file downloaded"
assert_contains "$(cat "$FAKE_LOG")" "releases/download/v1.2.3/docker-compose.release.yml" "downloads the chosen release"
assert_contains "$(cat "$FAKE_LOG")" "exec -T ollama ollama pull qwen3" "pulls the distill model in the container"
assert_contains "$(cat "$FAKE_LOG")" "exec -T ollama ollama pull nomic-embed-text" "pulls the embed model in the container"
assert_contains "$(cat "$FAKE_LOG")" "--user alice --role curator --json" "curator minted as \$USER"
assert_contains "$out" "tok-alice-curator" "summary prints the curator token"
assert_contains "$out" "not stored anywhere else" "summary says the token is shown once"
assert_contains "$out" "claude mcp add --transport http hive http://" "summary has the claude mcp add line"
assert_contains "$out" "| bash -s -- join --url http://" "summary has the Hermes join line"
assert_contains "$out" ":$PORT --token tok-alice-curator" "the join line has the URL and the curator token"
assert_no_file "$H/docker-compose.override.yml" "embed=container => no override"

new_case
run HIVE_EMBED=off HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
has_key OLLAMA_URL && pass || fail "embed=off writes OLLAMA_URL"
assert_eq "$(get OLLAMA_URL)" "" "embed=off => OLLAMA_URL empty"
assert_eq "$(get HIVE_DISTILL_RUNNER)" "claude" "distill=skip leaves the claude runner"
assert_no_file "$H/docker-compose.override.yml" "embed=off => no override"
assert_not_contains "$(cat "$FAKE_LOG")" "agent-credential" "distill=skip sets no credential"

new_case
out="$(run HIVE_EMBED=off HIVE_DISTILL=ollama bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "2" "distill=ollama with embed=off is refused"
assert_no_file "$H" "distill=ollama with embed=off => no install dir"

# --- the Claude token never shows up in .env, argv or output --------------------------
new_case
SECRET="sk-ant-oat01-SECRETSECRET"
out="$(run HIVE_EMBED=off HIVE_DISTILL=claude CLAUDE_CODE_OAUTH_TOKEN="$SECRET" bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "0" "distill=claude install succeeds"
assert_not_contains "$(cat "$H/.env")" "$SECRET" "the Claude token is not in .env"
assert_not_contains "$(cat "$FAKE_LOG")" "$SECRET" "the Claude token is in no argv"
assert_not_contains "$out" "$SECRET" "the Claude token is not printed"
assert_contains "$(cat "$FAKE_STDIN")" "{\"credential\":\"$SECRET\"}" "the credential goes on curl's stdin"
assert_contains "$(grep agent-credential "$FAKE_LOG")" "-K " "the bearer goes in a curl config"
assert_not_contains "$(grep agent-credential "$FAKE_LOG")" "tok-alice-curator" "the curator token is in no curl argv"

# --- re-run keeps POSTGRES_PASSWORD, doesn't re-mint ----------------------------------
pw="$(get POSTGRES_PASSWORD)"; sk="$(get HIVE_SECRET_KEY)"
: > "$FAKE_LOG"
out="$(run HIVE_EMBED=off HIVE_DISTILL=claude FAKE_CURATORS=1 FAKE_PS_PROJECT=hive FAKE_PS_WORKDIR="$H" \
  FAKE_VOLUMES=hive_pgdata bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "0" "re-run succeeds"
assert_eq "$(get POSTGRES_PASSWORD)" "$pw" "re-run keeps POSTGRES_PASSWORD"
assert_eq "$(get HIVE_SECRET_KEY)" "$sk" "re-run keeps HIVE_SECRET_KEY"
assert_not_contains "$(cat "$FAKE_LOG")" "mint-token" "re-run mints nothing (curator exists, worker token in .env)"
assert_contains "$out" "Settings" "re-run without the credential points to Settings"

# --- --force refused while the volume exists --------------------------------------------
before="$(cat "$H/.env")"
out="$(run HIVE_EMBED=off HIVE_DISTILL=skip FAKE_VOLUMES=hive_pgdata bash "$INSTALL_SH" --non-interactive --force 2>&1)"; code=$?
assert_eq "$code" "1" "--force with the volume => exit 1"
assert_contains "$out" "refusing --force" "--force with the volume => says so"
assert_eq "$(cat "$H/.env")" "$before" "--force refused => .env untouched"

# --- volume without .env refuses, per project ---------------------------------------------
new_case
out="$(run HIVE_EMBED=off HIVE_DISTILL=skip FAKE_VOLUMES=hive_pgdata bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "1" "hive_pgdata without .env => exit 1"
assert_contains "$out" "volume hive_pgdata exists" "names the volume"
assert_no_file "$H" "refused => no install dir"
new_case
out="$(run HIVE_EMBED=off HIVE_DISTILL=skip FAKE_VOLUMES=hive_pgdata bash "$INSTALL_SH" --non-interactive --project alt 2>&1)"; code=$?
assert_eq "$code" "0" "--project alt ignores another project's hive_pgdata"
new_case
out="$(run HIVE_EMBED=off HIVE_DISTILL=skip FAKE_VOLUMES=alt_pgdata bash "$INSTALL_SH" --non-interactive --project alt 2>&1)"; code=$?
assert_eq "$code" "1" "--project alt refuses with alt_pgdata and no .env"
assert_contains "$out" "alt_pgdata" "names alt_pgdata"

# --- a foreign project named hive refuses ------------------------------------------------
new_case
out="$(run HIVE_EMBED=off HIVE_DISTILL=skip FAKE_PS_PROJECT=hive FAKE_PS_WORKDIR=/somewhere/else \
  bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "1" "foreign project => exit 1"
assert_contains "$out" "/somewhere/else" "foreign project => names its dir"
assert_contains "$out" "--project" "foreign project => suggests --project"
assert_no_file "$H" "foreign project => no install dir"

# --- an unclean HIVE_HOME (//, trailing /, /./) is cleaned, so a re-run is still ours ---------
new_case
run HIVE_EMBED=off HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
for spelling in "$TMP/home$CASE//hive" "$TMP/home$CASE/hive/" "$TMP/home$CASE/hive/./"; do
  : > "$FAKE_LOG"
  out="$(run HIVE_EMBED=off HIVE_DISTILL=skip FAKE_PS_PROJECT=hive FAKE_PS_WORKDIR="$H" \
    bash "$INSTALL_SH" --non-interactive --dir "$spelling" 2>&1)"; code=$?
  assert_eq "$code" "0" "re-run with --dir $spelling passes the owner check"
  assert_not_contains "$out" "already runs from" "re-run with --dir $spelling isn't refused"
  calls="$(grep '^docker compose ' "$FAKE_LOG" | grep -v '^docker compose version')"
  [ -n "$calls" ] && pass || fail "re-run with --dir $spelling made compose calls"
  assert_eq "$(printf '%s\n' "$calls" | grep -vc -- "--project-directory $H -p hive ")" "0" \
    "re-run with --dir $spelling: every compose call has --project-directory $H"
done
out="$(run HIVE_HOME="$TMP/home$CASE//hive" HIVE_EMBED=off HIVE_DISTILL=skip FAKE_PS_PROJECT=hive \
  FAKE_PS_WORKDIR="$H" bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "0" "re-run with HIVE_HOME=<parent>//hive passes the owner check"
assert_eq "$(get HIVE_PROJECT)" "hive" "re-run with HIVE_HOME=<parent>//hive writes .env under the cleaned path"
new_case
out="$(run HIVE_HOME="$TMP/home$CASE//hive" HIVE_EMBED=off HIVE_DISTILL=skip FAKE_PS_PROJECT=hive \
  FAKE_PS_WORKDIR="$H" bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
assert_eq "$code" "0" "HIVE_HOME=<parent>//hive not created yet passes the owner check"
assert_file "$H/.env" "HIVE_HOME=<parent>//hive not created yet => .env under the cleaned path"
new_case
mkdir -p "$TMP/home$CASE/other"
out="$(run HIVE_EMBED=off HIVE_DISTILL=skip FAKE_PS_PROJECT=hive FAKE_PS_WORKDIR="$TMP/home$CASE/other" \
  bash "$INSTALL_SH" --non-interactive --dir "$TMP/home$CASE//hive/" 2>&1)"; code=$?
assert_eq "$code" "1" "another dir with the same project still refuses"
assert_contains "$out" "--project" "another dir with the same project => suggests --project"

# --- --project other: every compose call carries -p other ----------------------------------
new_case
out="$(run HIVE_EMBED=off HIVE_DISTILL=skip HIVE_MEMBERS=ann FAKE_PS_PROJECT=hive FAKE_PS_WORKDIR=/somewhere/else \
  bash "$INSTALL_SH" --non-interactive --project other 2>&1)"; code=$?
assert_eq "$code" "0" "--project other proceeds next to a foreign hive"
calls="$(grep '^docker compose ' "$FAKE_LOG" | grep -v '^docker compose version')"
[ -n "$calls" ] && pass || fail "--project other made compose calls"
assert_eq "$(printf '%s\n' "$calls" | grep -vc -- "--project-directory $H -p other ")" "0" "every compose call has -p other"
assert_eq "$(get HIVE_PROJECT)" "other" "HIVE_PROJECT=other persisted"

# --- the override file -------------------------------------------------------------------
new_case
run HIVE_EMBED=host HIVE_DISTILL=skip FAKE_OLLAMA=1 bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
assert_file "$H/docker-compose.override.yml" "Linux + plain engine + embed=host => override"
assert_contains "$(cat "$H/docker-compose.override.yml" 2>/dev/null)" "host.docker.internal:host-gateway" "override maps host-gateway"
assert_eq "$(get OLLAMA_URL)" "http://host.docker.internal:11434" "embed=host => OLLAMA_URL"
assert_contains "$(cat "$FAKE_LOG")" "/api/pull" "embed=host pulls through the Ollama API"
run HIVE_EMBED=off HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
assert_no_file "$H/docker-compose.override.yml" "changing embed to off removes the override it wrote"
printf 'services: {}\n' > "$H/docker-compose.override.yml"
run HIVE_EMBED=off HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
assert_file "$H/docker-compose.override.yml" "an override the user wrote is left alone"
for env in "FAKE_OS=Docker Desktop docker-desktop" "FAKE_OS=Rancher Desktop WSL Distribution lima-rancher-desktop" \
  "FAKE_UNAME=Darwin" "HIVE_EMBED=container" "HIVE_EMBED=off"; do
  new_case
  run HIVE_EMBED=host HIVE_DISTILL=skip "$env" bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
  assert_file "$H/.env" "install ran ($env)"
  assert_no_file "$H/docker-compose.override.yml" "no override with $env"
done

# --- embed default: host when a host Ollama answers, else off ----------------------------------
new_case
run HIVE_DISTILL=skip FAKE_OLLAMA=1 bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
assert_eq "$(get HIVE_EMBED)" "host" "embed defaults to host when Ollama answers"
new_case
run HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
assert_eq "$(get HIVE_EMBED)" "off" "embed defaults to off without a host Ollama"
assert_eq "$(get HIVE_VERSION)" "1.2.3" "HIVE_VERSION from the env"
new_case
run HIVE_VERSION= HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
assert_eq "$(get HIVE_VERSION)" "9.9.9" "no HIVE_VERSION => the latest release"

# --- --no-up writes the dir, starts nothing ---------------------------------------------------
new_case
run HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive --no-up >/dev/null 2>&1
assert_file "$H/.env" "--no-up writes .env"
assert_not_contains "$(cat "$FAKE_LOG")" " up -d" "--no-up starts nothing"

# --- run from a pipe: downloads itself into the install dir ------------------------------------
new_case
run HIVE_DISTILL=skip HIVE_INSTALL_URL=https://example.test/install.sh bash -s -- --non-interactive --no-up \
  < "$INSTALL_SH" >/dev/null 2>&1
assert_contains "$(cat "$FAKE_LOG")" "https://example.test/install.sh" "piped run downloads install.sh from HIVE_INSTALL_URL"

# --- a truncated script runs nothing --------------------------------------------------------
new_case
size="$(wc -c < "$INSTALL_SH")"
for cut in $((size / 3)) $((size / 2)) $((size - 20)); do
  head -c "$cut" "$INSTALL_SH" > "$TMP/trunc.sh"
  run HIVE_DISTILL=skip bash "$TMP/trunc.sh" --non-interactive >/dev/null 2>&1
  assert_no_file "$H" "truncated at $cut bytes => no install dir"
  assert_eq "$(grep -c . "$FAKE_LOG")" "0" "truncated at $cut bytes => no docker/curl calls"
done

# --- interactive: answers on a fake tty --------------------------------------------------------
# dir, version, bind, port, embed, distill, token (hidden), repos, curator user, curator name, teammates.
new_case
printf '%s\n' "" "" "" "" "off" "claude" "sk-ant-oat01-TYPEDTOKEN" "" "" "" "ann, bob" > "$TMP/tty"
out="$(run HIVE_TTY="$TMP/tty" bash "$INSTALL_SH" 2>&1)"; code=$?
assert_eq "$code" "0" "interactive install succeeds"
assert_contains "$out" "Port [$PORT]" "interactive shows the default"
assert_eq "$(get HIVE_VERSION)" "1.2.3" "empty reply takes the default (version)"
assert_eq "$(get HIVE_BIND)" "127.0.0.1" "empty reply takes the default (bind)"
assert_eq "$(get HIVE_EMBED)" "off" "typed answer (embed)"
assert_eq "$(get HIVE_DISTILL)" "claude" "typed answer (distill)"
assert_not_contains "$out" "TYPEDTOKEN" "the typed token is not echoed"
assert_contains "$(cat "$FAKE_STDIN")" "TYPEDTOKEN" "the typed token is sent"
assert_eq "$(grep -c 'mint-token.js --name ann --user ann ' "$FAKE_LOG")" "1" "one token for ann"
assert_eq "$(grep -c 'mint-token.js --name bob --user bob ' "$FAKE_LOG")" "1" "one token for bob"
assert_eq "$(grep -c 'role member' "$FAKE_LOG")" "2" "no other member tokens"
assert_contains "$out" "join --url http://127.0.0.1:$PORT --token tok-ann-member" "summary has ann's Hermes join line"
assert_contains "$out" "Bearer tok-bob-member" "summary has bob's claude mcp add line"

new_case
printf '%s\n' "" "" "" "" "off" "skip" "" "" "" "" > "$TMP/tty"
out="$(run HIVE_TTY="$TMP/tty" bash "$INSTALL_SH" 2>&1)"; code=$?
assert_eq "$code" "0" "interactive install with no teammates succeeds"
assert_eq "$(grep -c 'role member' "$FAKE_LOG")" "0" "empty teammates => no member tokens"

new_case
printf '%s\n' "" "" "" "99999999" "" "off" "skip" "" "" "" "" > "$TMP/tty"
out="$(run HIVE_TTY="$TMP/tty" bash "$INSTALL_SH" 2>&1)"; code=$?
assert_contains "$out" "not valid" "an invalid reply is asked again"
assert_eq "$(get HIVE_PORT)" "$PORT" "the re-asked question takes the next reply"

# --- members: HIVE_MEMBERS skips users that already have a token ---------------------------------
new_case
run HIVE_DISTILL=skip HIVE_MEMBERS="ann,bob" FAKE_USERS=ann bash "$INSTALL_SH" --non-interactive >/dev/null 2>&1
assert_eq "$(grep -c -- '--user ann ' "$FAKE_LOG")" "0" "an existing member is skipped"
assert_eq "$(grep -c -- '--user bob ' "$FAKE_LOG")" "1" "a new member gets one token"

# --- day 2: doctor, upgrade, uninstall (on a --no-up install) ---------------------------------------
new_day2_case() { new_case; run HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive --no-up >/dev/null 2>&1; : > "$FAKE_LOG"; }

new_day2_case
printf 'HIVE_WORKER_TOKEN=tok-worker-SECRET\n' >> "$H/.env"
out="$(run bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_eq "$code" "0" "doctor on healthy containers exits 0"
assert_contains "$out" "hive-worker: running, healthy" "doctor lists each service"
assert_contains "$out" "meaning search: ok" "doctor reads /v1/status"
assert_contains "$(grep /v1/status "$FAKE_LOG")" "-K " "doctor's worker token goes in a curl config"
assert_not_contains "$(cat "$FAKE_LOG")" "tok-worker-SECRET" "doctor's worker token is in no argv"
out="$(run FAKE_PS_HEALTH=unhealthy bash "$INSTALL_SH" doctor 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "doctor with an unhealthy container exits non-zero"
assert_contains "$out" "running, unhealthy" "doctor names the unhealthy container"
out="$(run HIVE_HOME="$TMP/home$CASE/nothing" bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_eq "$code" "2" "doctor without a .env exits 2"

# doctor's backups line: a warning, never a failure
new_day2_case
out="$(run bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_eq "$code" "0" "doctor with a fresh backup exits 0"
assert_contains "$out" "backups: newest hive-20261117-0300.dump (1 h old)" "doctor names the newest backup and its age"
assert_contains "$(cat "$FAKE_LOG")" "-p hive run --rm --no-deps -T backup newest" "doctor asks the backup service"
out="$(run FAKE_BACKUP_NEWEST="93600 hive-20261116-0300.dump" bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_contains "$out" "backups: newest hive-20261116-0300.dump (26 h old)" "a 26 h old backup is still fine"
out="$(run FAKE_BACKUP_NEWEST="97200 hive-20261116-0300.dump" bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_eq "$code" "0" "a 27 h old backup only warns"
assert_contains "$out" "! backups: the newest (hive-20261116-0300.dump) is 27 h old" "a 27 h old backup => warns with the age"
out="$(run FAKE_BACKUP_NEWEST=none bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_eq "$code" "0" "no backup only warns"
assert_contains "$out" "! backups: none yet" "no backup => warns"
assert_contains "$out" "backup once" "no backup => says how to take one"
out="$(run FAKE_BACKUP_NEWEST=fail bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_eq "$code" "0" "unreadable backups only warn"
assert_contains "$out" "! cannot read the backups" "unreadable backups => warns"
out="$(run FAKE_BACKUP_NEWEST="garbage" bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_contains "$out" "! cannot read the backups" "an unexpected answer => warns"
printf 'HIVE_BACKUPS=off\n' >> "$H/.env"
: > "$FAKE_LOG"
out="$(run FAKE_BACKUP_NEWEST=none bash "$INSTALL_SH" doctor 2>&1)"; code=$?
assert_contains "$out" "✓ backups: off" "HIVE_BACKUPS=off => ok, off"
assert_not_contains "$(cat "$FAKE_LOG")" "backup newest" "HIVE_BACKUPS=off => the backup service isn't asked"

new_day2_case
out="$(run bash "$INSTALL_SH" upgrade --project p2 2>&1)"; code=$?
assert_eq "$code" "0" "upgrade succeeds"
assert_eq "$(get HIVE_VERSION)" "9.9.9" "upgrade writes the latest release into HIVE_VERSION"
assert_contains "$(cat "$FAKE_LOG")" "releases/download/v9.9.9/docker-compose.release.yml" "upgrade downloads the release's compose file"
assert_contains "$(cat "$FAKE_LOG")" "-p p2 pull" "upgrade pulls"
assert_contains "$(cat "$FAKE_LOG")" "-p p2 up -d --wait" "upgrade starts the stack"
assert_eq "$(head -1 "$H/install.sh")" "#!/bin/sh" "upgrade refreshes install.sh"
[ -x "$H/install.sh" ] && pass || fail "the refreshed install.sh is executable"
assert_eq "$(ls -A "$H" | grep -c '^\.hive-upgrade')" "0" "upgrade leaves no staging dir"
: > "$FAKE_LOG"
out="$(run bash "$INSTALL_SH" upgrade --version v2.0.0 2>&1)"; code=$?
assert_eq "$(get HIVE_VERSION)" "2.0.0" "upgrade --version v2.0.0 => HIVE_VERSION=2.0.0"
assert_contains "$(cat "$FAKE_LOG")" "releases/download/v2.0.0/docker-compose.release.yml" "upgrade --version => that release's compose file"
out="$(run FAKE_NO_GITHUB=1 bash "$INSTALL_SH" upgrade 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "upgrade without a version and offline exits non-zero"
assert_eq "$(get HIVE_VERSION)" "2.0.0" "an offline upgrade changes nothing"

# a failed pull: nothing changes unless the new images are already here
new_day2_case
K="$TMP/keep$CASE"; mkdir -p "$K"; cp "$H/.env" "$H/docker-compose.yml" "$H/install.sh" "$K/"
out="$(run FAKE_PULL_FAIL=1 bash "$INSTALL_SH" upgrade --version 2.0.0 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "failed pull, images absent => exits non-zero"
assert_contains "$out" "nothing changed" "failed pull, images absent => says nothing changed"
for f in .env docker-compose.yml install.sh; do
  cmp -s "$K/$f" "$H/$f" && pass || fail "failed pull, images absent => $f unchanged"
done
assert_not_contains "$(cat "$FAKE_LOG")" " up -d" "failed pull, images absent => no up"
: > "$FAKE_LOG"
out="$(run FAKE_PULL_FAIL=1 FAKE_IMAGES="ghcr.io/bennybrau/hive:2.0.0 ghcr.io/bennybrau/hive-worker:2.0.0" \
  bash "$INSTALL_SH" upgrade --version 2.0.0 2>&1)"; code=$?
assert_eq "$code" "0" "failed pull, images present => upgrade succeeds"
assert_contains "$out" "images are already here" "failed pull, images present => warns"
assert_eq "$(get HIVE_VERSION)" "2.0.0" "failed pull, images present => HIVE_VERSION written"

# doctor fails after the upgrade: exit 1, install.sh kept
new_day2_case
cp "$H/install.sh" "$TMP/keep-install$CASE.sh"
out="$(run FAKE_PS_HEALTH=unhealthy bash "$INSTALL_SH" upgrade --version 2.0.0 2>&1)"; code=$?
assert_eq "$code" "1" "upgrade with an unhealthy stack exits 1"
cmp -s "$TMP/keep-install$CASE.sh" "$H/install.sh" && pass || fail "upgrade with an unhealthy stack keeps install.sh"

new_day2_case
out="$(run bash "$INSTALL_SH" uninstall 2>&1)"; code=$?
assert_eq "$code" "0" "uninstall succeeds"
assert_contains "$(cat "$FAKE_LOG")" "-p hive down --remove-orphans" "uninstall runs compose down"
assert_not_contains "$(cat "$FAKE_LOG")" " -v" "uninstall without --purge keeps the volumes"
assert_file "$H/.env" "uninstall without --purge keeps the dir"
assert_contains "$out" "the backups and $H are kept" "uninstall without --purge says the backups are kept"
: > "$FAKE_LOG"
out="$(run bash "$INSTALL_SH" uninstall --purge --non-interactive 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "--purge without --yes, non-interactive => refused"
assert_contains "$out" "--yes" "--purge refused => points to --yes"
assert_file "$H/.env" "--purge refused => the dir stays"
assert_eq "$(grep -c '^docker compose ' "$FAKE_LOG")" "0" "--purge refused => no compose calls"
printf 'wrong\n' > "$TMP/tty"
out="$(run HIVE_TTY="$TMP/tty" bash "$INSTALL_SH" uninstall --purge 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "--purge with the wrong name typed => refused"
assert_file "$H/.env" "--purge with the wrong name => the dir stays"
printf 'hive\n' > "$TMP/tty"
out="$(run HIVE_TTY="$TMP/tty" bash "$INSTALL_SH" uninstall --purge 2>&1)"; code=$?
assert_eq "$code" "0" "--purge with the project name typed succeeds"
assert_contains "$out" "in project hive, its backups, and $H" "the --purge prompt says the backups go too"
assert_contains "$(cat "$FAKE_LOG")" "-p hive down -v --remove-orphans" "--purge removes the volumes"
assert_no_file "$H" "--purge deletes the install dir"

new_day2_case
out="$(run bash "$INSTALL_SH" uninstall --purge --yes 2>&1)"; code=$?
assert_eq "$code" "0" "--purge --yes succeeds without a terminal"
assert_no_file "$H" "--purge --yes deletes the install dir"

# --purge keeps a dir that doesn't look like an install dir
new_day2_case
mkdir "$H/.git"
out="$(run bash "$INSTALL_SH" uninstall --purge --yes 2>&1)"; code=$?
assert_file "$H/.env" "--purge on a dir with .git => the dir stays"
assert_contains "$out" "not deleting" "--purge on a dir with .git => warns"
new_day2_case
grep -v '^HIVE_PROJECT=' "$H/.env" > "$H/.env.new"; mv "$H/.env.new" "$H/.env"
out="$(run bash "$INSTALL_SH" uninstall --purge --yes 2>&1)"; code=$?
assert_file "$H/.env" "--purge on a .env without HIVE_PROJECT => the dir stays"
assert_contains "$out" "no HIVE_PROJECT" "--purge on a .env without HIVE_PROJECT => warns"
new_day2_case
cp "$H/.env" "$H/docker-compose.yml" "$TMP/home$CASE/"
out="$(run bash "$INSTALL_SH" uninstall --purge --yes --dir "$TMP/home$CASE" 2>&1)"; code=$?
assert_file "$TMP/home$CASE/.env" "--purge on \$HOME => the dir stays"
assert_contains "$out" "not deleting" "--purge on \$HOME => warns"

# --purge never deletes a backup bind dir: one at or under the install dir keeps the dir
for spec in "HIVE_BACKUP_DIR=backups:@H@/backups" "HIVE_BACKUP_COPY_DIR=./copy/:@H@/copy" \
  "HIVE_BACKUP_DIR=~/hive/b:@H@/b" "HIVE_BACKUP_DIR=@H@:@H@"; do
  new_day2_case
  spec=${spec//@H@/$H}; kv=${spec%:*}; want=${spec##*:}
  printf '%s\n' "$kv" >> "$H/.env"
  mkdir -p "$want"; echo dump > "$want/hive-20261117-0300.dump"
  out="$(run bash "$INSTALL_SH" uninstall --purge --yes 2>&1)"; code=$?
  assert_eq "$code" "0" "--purge with $kv succeeds"
  assert_file "$want/hive-20261117-0300.dump" "--purge with $kv => the backups stay"
  assert_contains "$out" "it holds the backups (${kv%%=*}=$want)" "--purge with $kv => says why"
done
new_day2_case
printf 'HIVE_BACKUP_DIR=%s\n' "$TMP/home$CASE/elsewhere" >> "$H/.env"
mkdir -p "$TMP/home$CASE/elsewhere"; echo dump > "$TMP/home$CASE/elsewhere/hive-20261117-0300.dump"
out="$(run bash "$INSTALL_SH" uninstall --purge --yes 2>&1)"; code=$?
assert_no_file "$H" "--purge with HIVE_BACKUP_DIR outside the install dir => the install dir goes"
assert_file "$TMP/home$CASE/elsewhere/hive-20261117-0300.dump" "--purge => a HIVE_BACKUP_DIR outside it is untouched"
new_day2_case
printf 'HIVE_BACKUP_DIR=%s\n' "${H}-other" >> "$H/.env"
out="$(run bash "$INSTALL_SH" uninstall --purge --yes 2>&1)"; code=$?
assert_no_file "$H" "--purge with HIVE_BACKUP_DIR=<install dir>-other (a sibling, not inside) => the install dir goes"

# another dir's containers under the same project: no compose call at all
new_day2_case
for c in "upgrade --version 2.0.0" "uninstall" "uninstall --purge --yes"; do
  : > "$FAKE_LOG"
  out="$(run FAKE_PS_PROJECT=hive FAKE_PS_WORKDIR=/somewhere/else bash "$INSTALL_SH" $c 2>&1)"; code=$?
  [ "$code" -ne 0 ] && pass || fail "$c on another dir's project => exits non-zero"
  assert_contains "$out" "--project <name>" "$c on another dir's project => suggests --project"
  assert_eq "$(grep -c '^docker compose ' "$FAKE_LOG")" "0" "$c on another dir's project => no compose calls"
done
assert_file "$H/.env" "refused on another dir's project => the dir stays"
assert_eq "$(get HIVE_VERSION)" "1.2.3" "refused upgrade => HIVE_VERSION unchanged"

# docker can't list the project's containers: install, upgrade and uninstall refuse before any compose call
new_case
out="$(run FAKE_PS_FAIL=1 HIVE_DISTILL=skip bash "$INSTALL_SH" --non-interactive 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "install when docker ps fails => exits non-zero"
assert_contains "$out" "cannot list containers for project hive" "install when docker ps fails => says so"
assert_eq "$(grep '^docker compose ' "$FAKE_LOG" | grep -vc '^docker compose version')" "0" "install when docker ps fails => no compose calls"
assert_no_file "$H" "install when docker ps fails => no install dir"
new_day2_case
for c in "upgrade --version 2.0.0" "uninstall" "uninstall --purge --yes"; do
  : > "$FAKE_LOG"
  out="$(run FAKE_PS_FAIL=1 bash "$INSTALL_SH" $c 2>&1)"; code=$?
  [ "$code" -ne 0 ] && pass || fail "$c when docker ps fails => exits non-zero"
  assert_contains "$out" "cannot list containers" "$c when docker ps fails => says so"
  assert_eq "$(grep -c '^docker compose ' "$FAKE_LOG")" "0" "$c when docker ps fails => no compose calls"
done
assert_eq "$(get HIVE_VERSION)" "1.2.3" "upgrade when docker ps fails => HIVE_VERSION unchanged"

# --- join ----------------------------------------------------------------------------------
JTOKEN="hive_JOINSECRETTOKEN"
new_join_case() { new_case; HH="$TMP/home$CASE/hermes"; }
join() { # install.sh join with HERMES_HOME=$HH; extra env first, then the join options
  local envs=()
  while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do envs+=("$1"); shift; done
  ( cd "$TMP" && env HOME="$TMP/home$CASE" PATH="$FAKE_BIN:$PATH" HERMES_HOME="$HH" ${envs[@]+"${envs[@]}"} \
      bash "$INSTALL_SH" join "$@" )
}
jget() { awk -F= -v k="$1" '$1==k{print substr($0, length(k)+2)}' "$HH/.env" | tail -1; }

new_join_case
out="$(join HIVE_TOKEN="$JTOKEN" --url http://hive.test:8800/ 2>&1)"; code=$?
assert_eq "$code" "0" "join succeeds"
assert_eq "$(cat "$HH/plugins/hive/FROM" 2>/dev/null)" "release" "join installs the release plugin"
assert_contains "$(cat "$FAKE_LOG")" "releases/download/v1.2.3/hive-plugin.tar.gz" "X.Y.Z from /health => the release asset"
assert_eq "$(jget HIVE_URL)" "http://hive.test:8800" "HIVE_URL in .env, trailing / trimmed"
assert_eq "$(jget HIVE_TOKEN)" "$JTOKEN" "HIVE_TOKEN from the env in .env"
assert_eq "$(perm "$HH/.env")" "600" "Hermes .env is mode 600"
assert_not_contains "$(cat "$FAKE_LOG")" "$JTOKEN" "the token is in no argv"
assert_contains "$(grep /v1/status "$FAKE_LOG")" "-K " "the bearer goes in a curl config"
assert_contains "$(cat "$FAKE_LOG")" "hermes config set memory.provider hive (HERMES_HOME=$HH)" "join activates hive with HERMES_HOME"
assert_contains "$(cat "$FAKE_LOG")" "hermes memory status (HERMES_HOME=$HH)" "join checks the memory status"
assert_not_contains "$(cat "$FAKE_LOG")" "docker" "join makes no docker calls"
assert_eq "$(ls -A "$HH/plugins")" "hive" "no staging dir left behind"

# re-join: keys replaced, not duplicated; unrelated keys kept; the old plugin dir replaced
printf 'OPENAI_API_KEY=keepme\n' >> "$HH/.env"
echo stale > "$HH/plugins/hive/STALE"
out="$(join --url http://other.test:8800 --token tok2 2>&1)"; code=$?
assert_eq "$code" "0" "re-join succeeds"
assert_eq "$(grep -c '^HIVE_URL=' "$HH/.env")" "1" "re-join: one HIVE_URL"
assert_eq "$(grep -c '^HIVE_TOKEN=' "$HH/.env")" "1" "re-join: one HIVE_TOKEN"
assert_eq "$(jget HIVE_URL)" "http://other.test:8800" "re-join: new HIVE_URL"
assert_eq "$(jget HIVE_TOKEN)" "tok2" "re-join: --token wins"
assert_eq "$(jget OPENAI_API_KEY)" "keepme" "re-join keeps unrelated keys"
assert_no_file "$HH/plugins/hive/STALE" "re-join replaces the old plugin dir"
assert_eq "$(perm "$HH/.env")" "600" "re-join: .env still mode 600"

# version -> source
new_join_case
out="$(join FAKE_HEALTH_VERSION=main-abc1234 --url http://hive.test:8800 --token t 2>&1)"; code=$?
assert_eq "$code" "0" "join against a main build succeeds"
assert_contains "$(cat "$FAKE_LOG")" "codeload.github.com/bennybrau/hive/tar.gz/abc1234" "main-<sha7> => the repo tarball"
assert_eq "$(cat "$HH/plugins/hive/FROM" 2>/dev/null)" "codeload" "main-<sha7> => plugins/hive from the repo tarball"
for v in 0.0.1 dev; do
  new_join_case
  out="$(join FAKE_HEALTH_VERSION=$v --url http://hive.test:8800 --token t 2>&1)"; code=$?
  [ "$code" -ne 0 ] && pass || fail "/health version $v => join refuses"
  assert_contains "$out" "--version <v>" "/health version $v => asks for --version"
  assert_no_file "$HH" "/health version $v => nothing written"
done
new_join_case
out="$(join FAKE_HEALTH_VERSION=dev --url http://hive.test:8800 --token t --version 2.0.0 2>&1)"; code=$?
assert_eq "$code" "0" "an explicit --version X.Y.Z is accepted"
assert_contains "$(cat "$FAKE_LOG")" "releases/download/v2.0.0/hive-plugin.tar.gz" "--version 2.0.0 => that release's plugin"

# a bad token writes nothing
new_join_case
out="$(join FAKE_STATUS_CODE=401 --url http://hive.test:8800 --token bad 2>&1)"; code=$?
assert_eq "$code" "1" "/v1/status 401 => exit 1"
assert_contains "$out" "/v1/status answered 401" "/v1/status 401 => says so"
assert_no_file "$HH" "/v1/status 401 => nothing written"
assert_not_contains "$(cat "$FAKE_LOG")" "hive-plugin.tar.gz" "/v1/status 401 => nothing downloaded"

# a symlinked plugin dir (a checkout) is refused without --force, replaced with it; its target is kept
new_join_case
mkdir -p "$TMP/home$CASE/checkout/plugins/hive" "$HH/plugins"
echo mine > "$TMP/home$CASE/checkout/plugins/hive/KEEP"
ln -s "$TMP/home$CASE/checkout/plugins/hive" "$HH/plugins/hive"
out="$(join --url http://hive.test:8800 --token t 2>&1)"; code=$?
assert_eq "$code" "1" "symlinked plugin dir => exit 1"
assert_contains "$out" "--force" "symlinked plugin dir => suggests --force"
[ -L "$HH/plugins/hive" ] && pass || fail "refused => the symlink is still there"
assert_eq "$(cat "$TMP/home$CASE/checkout/plugins/hive/KEEP")" "mine" "refused => the link target is untouched"
assert_no_file "$HH/.env" "refused => no .env"
out="$(join --url http://hive.test:8800 --token t --force 2>&1)"; code=$?
assert_eq "$code" "0" "--force replaces the symlink"
[ ! -L "$HH/plugins/hive" ] && [ -d "$HH/plugins/hive" ] && pass || fail "--force => a real plugin dir"
assert_eq "$(cat "$HH/plugins/hive/FROM" 2>/dev/null)" "release" "--force => the downloaded plugin"
assert_eq "$(cat "$TMP/home$CASE/checkout/plugins/hive/KEEP" 2>/dev/null)" "mine" "--force => the link target is kept"

# the provider check reads the Provider: line only
new_join_case
out="$(join FAKE_HERMES_STATUS=$'Memory status\n  Provider:  hive\n' --url http://hive.test:8800 --token t 2>&1)"; code=$?
assert_eq "$code" "0" "Provider:  hive => join passes"
new_join_case
status=$'Memory status\n  Built-in:  on\n  Provider:  (none — built-in only)\n\nInstalled plugins:\n  • hive\n'
out="$(join FAKE_HERMES_STATUS="$status" --url http://hive.test:8800 --token t 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "Provider: (none) with hive installed => join fails"
assert_contains "$out" "Provider:  (none — built-in only)" "a failed provider check shows the Provider line"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
