#!/usr/bin/env bash
# Tests for scripts/install.sh. No Docker or network needed.
#
#   bash scripts/install.test.sh
#
# Fake `docker`, `curl` and `uname` on PATH log their argv to $FAKE_LOG and serve canned answers, steered by
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
# FAKE_CURATORS (live curator count), FAKE_USERS (users that already have a token).
cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  info)
    [ "${FAKE_INFO_FAIL:-}" = 1 ] && exit 1
    [ "${2:-}" = "--format" ] && echo "${FAKE_OS:-Ubuntu 24.04 LTS testhost}"
    exit 0 ;;
  volume)
    for v in ${FAKE_VOLUMES:-}; do [ "$3" = "$v" ] && exit 0; done
    exit 1 ;;
  ps)
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
      *"psql"*"role='curator'"*) echo "${FAKE_CURATORS:-0}" ;;
      *"psql"*"user_id="*)
        n=0; for u in ${FAKE_USERS:-}; do case "$*" in *"user_id='$u'"*) n=1 ;; esac; done; echo "$n" ;;
      *"psql"*) echo 0 ;;
    esac
    exit 0 ;;
esac
exit 0
EOF

# curl: FAKE_OLLAMA=1 (a host Ollama answers), FAKE_NO_GITHUB=1 (no latest release). Records stdin when the body is read from it.
cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$FAKE_LOG"
out=""; prev=""; url=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out=$a
  case "$a" in http*) url=$a ;; @-) cat >> "$FAKE_STDIN"; printf '\n' >> "$FAKE_STDIN" ;; esac
  prev=$a
done
case "$url" in
  *api.github.com*) [ "${FAKE_NO_GITHUB:-}" = 1 ] && exit 22; echo '{"tag_name": "v9.9.9"}' ;;
  *:11434*) [ "${FAKE_OLLAMA:-}" = 1 ] || exit 7 ;;
  */health) echo '{"ok":true}' ;;
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
chmod +x "$FAKE_BIN"/*

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
assert_contains "$out" "HIVE_TOKEN=tok-alice-curator" "summary has a Hermes block"
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
assert_contains "$out" "HIVE_TOKEN=tok-ann-member" "summary has ann's Hermes block"
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

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
