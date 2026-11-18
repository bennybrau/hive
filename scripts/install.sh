#!/usr/bin/env bash
#
# Hive install wizard: one command from nothing to a running Hive with tokens printed. Needs Docker and curl,
# no checkout.
#
#   curl -fsSL https://raw.githubusercontent.com/bennybrau/hive/main/scripts/install.sh | bash
#   ~/hive/install.sh                                  # re-run: keeps .env, fills what is missing
#   HIVE_DISTILL=skip ~/hive/install.sh --non-interactive
#   curl -fsSL .../install.sh | bash -s -- join --url http://hive:8800 --token hive_...   # connect this Hermes
#
# Every prompt, its default and its env var: docs/INSTALL.md. All checks run before anything is written.
# The whole body is in main(), called on the last line, so a truncated download runs nothing.
#
set -euo pipefail

SELF="${BASH_SOURCE[0]:-}"
REPO="bennybrau/hive"
RELEASES="https://github.com/${REPO}/releases"
OVERRIDE_MARK="# written by hive install.sh (embed=host on a plain Linux engine); re-run the installer to change it"

# --- presentation -----------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_BOLD=''; C_DIM=''
fi

FAILURES=0
ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$1"; [ -n "${2:-}" ] && printf '      %s%s%s\n' "$C_DIM" "$2" "$C_RESET"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
info() { printf '    %s\n' "$1"; }
section() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"; }
die() { printf '%s%s%s\n' "$C_RED" "$1" "$C_RESET" >&2; exit "${2:-1}"; }
stop_if_failed() {
  if [ "$FAILURES" -gt 0 ]; then
    printf '\n%s%d check(s) failed - fix the above and re-run. Nothing was written.%s\n' "$C_RED" "$FAILURES" "$C_RESET" >&2
    exit 1
  fi
}

usage() {
  cat <<'EOF'
Hive install wizard.

Usage: install.sh [install] [options]
       install.sh join --url <hive url> [--token <t>] [--version <v>] [--force]

  --version <v>       Hive release to install, e.g. 0.2.0 (default: the latest release)
  --dir <path>        install directory (default ~/hive)
  --project <name>    docker compose project (default hive); use another to run a second Hive on this host
  --non-interactive   never prompt; answers come from the environment (see docs/INSTALL.md)
  --no-up             write the install directory, start nothing
  --force             regenerate .env (refused while the project's database volume exists)
  --help              show this help

Environment (the --non-interactive answers; interactive mode shows them as the defaults):
  HIVE_HOME HIVE_VERSION HIVE_PROJECT HIVE_BIND HIVE_PORT HIVE_EMBED=host|container|off
  HIVE_DISTILL=claude|ollama|skip CLAUDE_CODE_OAUTH_TOKEN HIVE_DISTILL_MODEL HIVE_REPOS_HOST_ROOT
  HIVE_CURATOR_USER HIVE_CURATOR_NAME HIVE_MEMBERS=ann,bob HIVE_CURATOR_TOKEN
Sources: HIVE_COMPOSE_SRC=<path> (a local compose file instead of the release's), HIVE_INSTALL_URL.

join: connect this machine's Hermes to a Hive. Installs the hive plugin into $HERMES_HOME/plugins/hive, writes
HIVE_URL and HIVE_TOKEN into $HERMES_HOME/.env and makes hive the memory provider.
  --url <u>           the Hive's URL
  --token <t>         this instance's token (default: $HIVE_TOKEN)
  --version <v>       plugin version, X.Y.Z or main-<sha7> (default: the version the Hive reports)
  --force             replace a plugin dir that is a symlink (e.g. into a checkout)
  HERMES_HOME         the Hermes home (default ~/.hermes): plugin dir, .env and config
EOF
}

# --- helpers ----------------------------------------------------------------
# Every compose call, so each one carries the project and finds .env and the override in the install dir.
dc() { docker compose --project-directory "$HIVE_HOME" -p "$HIVE_PROJECT" "$@"; }

# Stop when compose project $1 already belongs to another install dir than $2 (containers carry the dir they
# were started from). Prints the problem and returns 1; returns 0 when the project is free or already ours.
check_project_owner() {
  local project=$1 dir=$2 wd
  while IFS= read -r wd; do
    [ -n "$wd" ] || continue
    if [ "$wd" != "$dir" ]; then
      bad "compose project '${project}' already runs from ${wd}" \
        "that is another Hive; to install a second one here, re-run with --project <name>"
      return 1
    fi
  done <<EOF
$(docker ps -a --filter "label=com.docker.compose.project=${project}" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)
EOF
  return 0
}

rand_hex() { # $1 = bytes of entropy -> 2*$1 hex chars
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

port_in_use() { # $1 = port ; 0 if something is listening on loopback
  (exec 9<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Rewrite (or append) KEY=VALUE, matching only a line that starts with "KEY=" (comments are left alone).
# Pure bash, no sed, so any value is written verbatim.
set_env_key() {
  local file=$1 key=$2 value=$3 line found=0 tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "${line%%=*}" = "$key" ] && [ "${line#"$key"=}" != "$line" ]; then
      [ "$found" -eq 0 ] && printf '%s=%s\n' "$key" "$value" >> "$tmp"
      found=1
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$file"
  [ "$found" -eq 0 ] && printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

read_env_key() { # $1 = file, $2 = key ; prints the last value found (blank if none)
  local file=$1 key=$2 line val=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [ "${line%%=*}" = "$key" ] && [ "${line#"$key"=}" != "$line" ] && val="${line#"$key"=}"
  done < "$file"
  printf '%s' "$val"
}

# ask VAR "question" default [regex] [secret]
# Interactive: shows [default] (the env var when non-empty, else the default) and an empty reply takes it; a reply that
# doesn't match the regex is asked again. --non-interactive: the env var when non-empty, else the default; a value that
# doesn't match (an empty required one included) fails and names the variable. A flag (--dir, --version) fixes
# the answer and skips the question. Secrets are read hidden and never shown.
ask() {
  local var=$1 question=$2 def=${3-} re=${4:-} secret=${5:-} reply eof=0 keep=none
  [ -n "${!var:-}" ] && def=${!var}
  case " $FIXED " in *" $var "*) re="" ;; esac
  [ -n "$def" ] && keep="keep the one given"
  while :; do
    reply=$def
    case " $FIXED " in *" $var "*) ;; *)
      if [ "$INTERACTIVE" -eq 1 ]; then
        if [ -n "$secret" ]; then
          printf '  %s (hidden, empty = %s): ' "$question" "$keep"
          IFS= read -r -s -u 3 reply || eof=1
          printf '\n'
        else
          printf '  %s [%s]: ' "$question" "$def"
          IFS= read -r -u 3 reply || eof=1
        fi
        [ -n "$reply" ] || reply=$def
      fi ;;
    esac
    if [ -z "$re" ] || [[ "$reply" =~ $re ]]; then break; fi
    if [ "$INTERACTIVE" -eq 1 ] && [ "$eof" -eq 0 ]; then
      printf '    %snot valid%s\n' "$C_RED" "$C_RESET"
      continue
    fi
    if [ -z "$reply" ]; then die "missing answer: set ${var} (${question})" 2; fi
    if [ -n "$secret" ]; then die "${var} is not valid" 2; fi
    die "${var}='${reply}' is not valid (${question})" 2
  done
  printf -v "$var" '%s' "$reply"
}

# ~ and relative paths -> absolute and clean (the dir need not exist yet). Compose stores the project's
# working_dir cleaned, and check_project_owner compares against it, so no //, /./ or trailing /.
expand_dir() {
  local d=$1
  case "$d" in "~") d=$HOME ;; "~/"*) d="$HOME/${d#\~/}" ;; esac
  case "$d" in /*) ;; *) d="$PWD/$d" ;; esac
  while [ "${d//\/\///}" != "$d" ]; do d=${d//\/\///}; done
  while [ "${d//\/.\///}" != "$d" ]; do d=${d//\/.\///}; done
  case "$d" in */.) d=${d%.} ;; esac
  while [ "${d%/}" != "$d" ] && [ "$d" != "/" ]; do d=${d%/}; done
  [ -d "$d" ] && d="$(cd -- "$d" && pwd)"
  printf '%s' "$d"
}

# Plain Linux engine: host.docker.internal needs a host-gateway mapping there (Docker/Rancher Desktop have one).
plain_linux_engine() {
  [ "$(uname -s)" = "Linux" ] || return 1
  case "$(docker info --format '{{.OperatingSystem}} {{.Name}}' 2>/dev/null | tr '[:upper:]' '[:lower:]')" in
    *"docker desktop"*|*rancher*) return 1 ;;
  esac
  return 0
}

mint() { # $1 = instance name, $2 = user, $3 = role -> prints the token
  local out
  out="$(dc exec -T hive node dist/cli/mint-token.js --name "$1" --user "$2" --role "$3" --json)" || return 1
  printf '%s\n' "$out" | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p'
}

psql_count() { # $1 = sql -> a number
  local n
  n="$(dc exec -T postgres psql -U hive -d hive -tAc "$1")" || return 1
  printf '%s' "${n//[[:space:]]/}"
}

pull_model() { # $1 = model ; through the host's Ollama API or the bundled container
  if [ "$HIVE_EMBED" = "container" ]; then
    if dc exec -T ollama ollama pull "$1" >/dev/null; then ok "pulled $1 (ollama container)"
    else warn "could not pull $1; later: docker compose -p ${HIVE_PROJECT} exec ollama ollama pull $1"; fi
  else
    if curl -fsS -X POST http://127.0.0.1:11434/api/pull --data-binary "{\"name\":\"$1\",\"stream\":false}" >/dev/null; then
      ok "pulled $1 (host Ollama)"
    else warn "could not pull $1 through the host Ollama; later: ollama pull $1"; fi
  fi
}

# PUT the fact agent's credential with curator token $1. The body goes on stdin and the bearer in a mode-600
# curl config, so neither is in any process's argv.
put_credential() {
  local cfg code esc
  cfg="$(mktemp)"; chmod 600 "$cfg"
  printf 'header = "Authorization: Bearer %s"\n' "$1" > "$cfg"
  esc=${CLAUDE_CODE_OAUTH_TOKEN//\\/\\\\}; esc=${esc//\"/\\\"}
  code="$(printf '{"credential":"%s"}' "$esc" | curl -sS -K "$cfg" -X PUT -H 'Content-Type: application/json' \
    --data-binary @- -o /dev/null -w '%{http_code}' "${LOCAL_URL}/v1/settings/agent-credential" || true)"
  rm -f "$cfg"
  [ "$code" = "204" ]
}

person_block() { # $1 = who, $2 = token
  cat <<EOF

  ${C_BOLD}$1${C_RESET}
    Claude Code:
      claude mcp add --transport http hive ${PUBLIC_URL}/mcp --header "Authorization: Bearer $2"
    Hermes:
      curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | bash -s -- join --url ${PUBLIC_URL} --token $2
EOF
}

# --- install ----------------------------------------------------------------
cmd_install() {
  local INTERACTIVE=1 FORCE=0 NO_UP=0 FIXED=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) HIVE_VERSION="${2:?--version needs a value}"; FIXED="$FIXED HIVE_VERSION"; shift 2 ;;
      --dir) HIVE_HOME="${2:?--dir needs a value}"; FIXED="$FIXED HIVE_HOME"; shift 2 ;;
      --project) HIVE_PROJECT="${2:?--project needs a value}"; shift 2 ;;
      --non-interactive) INTERACTIVE=0; shift ;;
      --no-up) NO_UP=1; shift ;;
      --force) FORCE=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
  done

  # The answers come from the terminal even under `curl | bash` (stdin is the script there).
  # HIVE_TTY (a file of answers, one per line) is the test hook.
  if [ "$INTERACTIVE" -eq 1 ]; then
    local tty="${HIVE_TTY:-/dev/tty}"
    if (: <"$tty") 2>/dev/null; then exec 3<"$tty"
    else INTERACTIVE=0; warn "no terminal to ask on; continuing as --non-interactive"; fi
  fi

  # --- preflight (host) -----------------------------------------------------
  section "Preflight"
  local DOCKER_OK=0
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then ok "docker daemon reachable"; DOCKER_OK=1
    else bad "docker is installed but the daemon is not reachable" "start Docker Desktop / Rancher / the docker service, then re-run"; fi
  else
    bad "docker not found" "install Docker: https://docs.docker.com/get-docker/"
  fi
  if [ "$DOCKER_OK" -eq 1 ] && docker compose version >/dev/null 2>&1; then
    ok "docker compose v2 ($(docker compose version --short 2>/dev/null || echo present))"
  elif [ "$DOCKER_OK" -eq 1 ]; then
    bad "docker compose v2 not available" "install the Compose v2 plugin (the 'docker compose' subcommand, not docker-compose)"
  fi
  if command -v curl >/dev/null 2>&1; then ok "curl"; else bad "curl not found" "install curl, then re-run"; fi
  if command -v openssl >/dev/null 2>&1; then ok "openssl (secret generation)"
  elif [ -r /dev/urandom ]; then ok "/dev/urandom (secret generation)"
  else bad "no way to generate secrets" "install openssl, or make /dev/urandom readable"; fi
  stop_if_failed

  # --- questions --------------------------------------------------------------
  section "Questions"
  local NAME_RE='^[A-Za-z0-9._-]+$'
  ask HIVE_HOME "Install directory" "~/hive" '.+'
  HIVE_HOME="$(expand_dir "$HIVE_HOME")"
  local ENV_FILE="$HIVE_HOME/.env" FRESH=1
  [ -f "$ENV_FILE" ] && [ "$FORCE" -ne 1 ] && FRESH=0
  # On a re-run the last answers (in .env) are the defaults.
  prev() { local v; v="$(read_env_key "$ENV_FILE" "$1")"; printf '%s' "${v:-$2}"; }

  [ -n "${HIVE_PROJECT:-}" ] || HIVE_PROJECT="$(prev HIVE_PROJECT hive)"
  [[ "$HIVE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "--project '${HIVE_PROJECT}' is not a valid compose project name (a-z, 0-9, - and _)" 2

  local latest=""
  if [ -z "${HIVE_VERSION:-}" ] && [ -z "$(read_env_key "$ENV_FILE" HIVE_VERSION)" ]; then
    latest="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name" *: *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1 || true)"
  fi
  ask HIVE_VERSION "Hive version" "$(prev HIVE_VERSION "$latest")" '^v?[0-9A-Za-z._-]+$'
  HIVE_VERSION=${HIVE_VERSION#v}

  local tsip="" bind_q="Listen on (127.0.0.1 = this machine, 0.0.0.0 = every interface"
  tsip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [ -n "$tsip" ] && bind_q="${bind_q}, ${tsip} = Tailscale"
  ask HIVE_BIND "${bind_q})" "$(prev HIVE_BIND 127.0.0.1)" '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
  ask HIVE_PORT "Port" "$(prev HIVE_PORT 8800)" '^[1-9][0-9]{0,4}$'

  local embed_def=off
  curl -fsS -m 2 -o /dev/null http://127.0.0.1:11434/ 2>/dev/null && embed_def=host
  ask HIVE_EMBED "Meaning search with Ollama: host (Ollama on this machine), container (bundled) or off" \
    "$(prev HIVE_EMBED "$embed_def")" '^(host|container|off)$'

  ask HIVE_DISTILL "Fact agent: claude (your Claude subscription token), ollama (a local model) or skip (set it later)" \
    "$(prev HIVE_DISTILL claude)" '^(claude|ollama|skip)$'
  if [ "$HIVE_DISTILL" = "claude" ]; then
    # Required on a first install without a terminal; on a re-run empty keeps whatever the Hive has.
    local tok_re='.*'
    [ "$INTERACTIVE" -eq 0 ] && [ "$FRESH" -eq 1 ] && tok_re='.+'
    ask CLAUDE_CODE_OAUTH_TOKEN "Claude token (claude setup-token)" "" "$tok_re" secret
  elif [ "$HIVE_DISTILL" = "ollama" ]; then
    [ "$HIVE_EMBED" != "off" ] || die "HIVE_DISTILL=ollama needs an Ollama: choose HIVE_EMBED=host or container" 2
    ask HIVE_DISTILL_MODEL "Ollama model for the fact agent" "$(prev HIVE_DISTILL_MODEL llama3.1)" "$NAME_RE"
  fi

  ask HIVE_REPOS_HOST_ROOT "Directory of repos the Hive may read (empty = none)" "$(prev HIVE_REPOS_HOST_ROOT "")"
  [ -z "$HIVE_REPOS_HOST_ROOT" ] || HIVE_REPOS_HOST_ROOT="$(expand_dir "$HIVE_REPOS_HOST_ROOT")"
  local host_short
  host_short="$( (hostname -s || hostname || uname -n) 2>/dev/null | head -1 || true)"
  ask HIVE_CURATOR_USER "Your user name (the curator)" "${USER:-curator}" "$NAME_RE"
  ask HIVE_CURATOR_NAME "This instance's name" "${host_short:-hive}-curator" "$NAME_RE"
  ask HIVE_MEMBERS "Teammates' names (comma list, empty = none)" "" \
    '^[[:space:]]*([A-Za-z0-9._-]+[[:space:]]*(,[[:space:]]*[A-Za-z0-9._-]+[[:space:]]*)*)?$'

  # --- preflight (answers) --------------------------------------------------
  section "Checks"
  if check_project_owner "$HIVE_PROJECT" "$HIVE_HOME"; then ok "compose project ${HIVE_PROJECT}"; fi
  local OURS=0
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=${HIVE_PROJECT}" 2>/dev/null || true)" ] && OURS=1
  local VOLUME="${HIVE_PROJECT}_pgdata" VOLUME_EXISTS=0
  docker volume inspect "$VOLUME" >/dev/null 2>&1 && VOLUME_EXISTS=1
  if [ "$FORCE" -eq 1 ] && [ "$VOLUME_EXISTS" -eq 1 ]; then
    bad "refusing --force: volume ${VOLUME} exists" \
      "a new POSTGRES_PASSWORD would not match the database. Drop --force, or remove the volume deliberately (destroys all hive data)"
  elif [ ! -f "$ENV_FILE" ] && [ "$VOLUME_EXISTS" -eq 1 ]; then
    bad "refusing: volume ${VOLUME} exists but ${ENV_FILE} is missing" \
      "a new POSTGRES_PASSWORD would not match the database. Restore .env, or remove the volume deliberately (docker volume rm ${VOLUME} - destroys all hive data)"
  else
    ok "database volume ${VOLUME}: $([ "$VOLUME_EXISTS" -eq 1 ] && echo "kept" || echo "new")"
  fi
  if port_in_use "$HIVE_PORT" && [ "$OURS" -eq 0 ]; then
    bad "port ${HIVE_PORT} is in use" "choose another (HIVE_PORT), or stop what holds it"
  else ok "port ${HIVE_PORT}"; fi
  local disk_dir avail_kb
  disk_dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  [ -d "$disk_dir" ] || disk_dir=$HOME
  avail_kb="$(df -Pk "$disk_dir" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  if [ -n "$avail_kb" ] && [ "$((avail_kb / 1024 / 1024))" -lt 5 ]; then
    warn "only $((avail_kb / 1024 / 1024)) GB free at ${disk_dir}; the images and the database want 5 GB or more"
  fi

  # Fetch into a temp dir now, so a failed download writes nothing.
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  if [ -n "${HIVE_COMPOSE_SRC:-}" ]; then
    if cp "$HIVE_COMPOSE_SRC" "$STAGE/compose.yml" 2>/dev/null; then ok "compose file from ${HIVE_COMPOSE_SRC}"
    else bad "cannot read HIVE_COMPOSE_SRC=${HIVE_COMPOSE_SRC}"; fi
    local src_dir
    src_dir="$(dirname "$HIVE_COMPOSE_SRC")"
    if [ -f "$src_dir/hive.env.example" ]; then cp "$src_dir/hive.env.example" "$STAGE/env.example"
    elif [ -f "$src_dir/.env.example" ]; then cp "$src_dir/.env.example" "$STAGE/env.example"; fi
  else
    if curl -fsSL -o "$STAGE/compose.yml" "${RELEASES}/download/v${HIVE_VERSION}/docker-compose.release.yml"; then
      ok "downloaded the v${HIVE_VERSION} compose file"
    else bad "cannot download release v${HIVE_VERSION}" "check the version (${RELEASES}) and the network"; fi
  fi
  if [ ! -f "$STAGE/env.example" ] && ! curl -fsSL -o "$STAGE/env.example" "${RELEASES}/download/v${HIVE_VERSION}/hive.env.example"; then
    : > "$STAGE/env.example"   # comments only; the keys below are what matter
    warn "no hive.env.example for v${HIVE_VERSION}; writing .env without its comments"
  fi
  stop_if_failed

  # --- act --------------------------------------------------------------------
  section "Install (${HIVE_HOME}, project ${HIVE_PROJECT})"
  mkdir -p "$HIVE_HOME"
  mv "$STAGE/compose.yml" "$HIVE_HOME/docker-compose.yml"
  ok "docker-compose.yml (v${HIVE_VERSION})"

  if [ "$FRESH" -eq 1 ]; then
    [ -f "$ENV_FILE" ] && cp "$ENV_FILE" "$ENV_FILE.bak" && chmod 600 "$ENV_FILE.bak" && info "old .env kept as .env.bak"
    (umask 077; cp "$STAGE/env.example" "$ENV_FILE")
    set_env_key "$ENV_FILE" POSTGRES_PASSWORD "$(rand_hex 24)"
    set_env_key "$ENV_FILE" HIVE_SECRET_KEY "$(rand_hex 32)"
    set_env_key "$ENV_FILE" HIVE_WORKER_TOKEN ""
    ok "wrote .env (new secrets)"
  else
    ok "keeping .env (only missing keys are filled)"
    [ -n "$(read_env_key "$ENV_FILE" POSTGRES_PASSWORD)" ] || set_env_key "$ENV_FILE" POSTGRES_PASSWORD "$(rand_hex 24)"
    [ -n "$(read_env_key "$ENV_FILE" HIVE_SECRET_KEY)" ] || { set_env_key "$ENV_FILE" HIVE_SECRET_KEY "$(rand_hex 32)"; ok "added HIVE_SECRET_KEY"; }
  fi
  set_env_key "$ENV_FILE" HIVE_PROJECT "$HIVE_PROJECT"
  set_env_key "$ENV_FILE" HIVE_VERSION "$HIVE_VERSION"
  set_env_key "$ENV_FILE" HIVE_BIND "$HIVE_BIND"
  set_env_key "$ENV_FILE" HIVE_PORT "$HIVE_PORT"
  set_env_key "$ENV_FILE" HIVE_REPOS_HOST_ROOT "$HIVE_REPOS_HOST_ROOT"
  set_env_key "$ENV_FILE" HIVE_EMBED "$HIVE_EMBED"
  case "$HIVE_EMBED" in
    host)      set_env_key "$ENV_FILE" OLLAMA_URL "http://host.docker.internal:11434"; set_env_key "$ENV_FILE" COMPOSE_PROFILES "" ;;
    container) set_env_key "$ENV_FILE" OLLAMA_URL "http://ollama:11434"; set_env_key "$ENV_FILE" COMPOSE_PROFILES "ollama" ;;
    off)       set_env_key "$ENV_FILE" OLLAMA_URL ""; set_env_key "$ENV_FILE" COMPOSE_PROFILES "" ;;
  esac
  set_env_key "$ENV_FILE" HIVE_DISTILL "$HIVE_DISTILL"
  if [ "$HIVE_DISTILL" = "ollama" ]; then
    set_env_key "$ENV_FILE" HIVE_DISTILL_RUNNER ollama
    set_env_key "$ENV_FILE" HIVE_DISTILL_MODEL "$HIVE_DISTILL_MODEL"
  else
    set_env_key "$ENV_FILE" HIVE_DISTILL_RUNNER claude
    set_env_key "$ENV_FILE" HIVE_DISTILL_MODEL ""
  fi
  chmod 600 "$ENV_FILE"
  ok ".env (mode 600)"

  local OVERRIDE="$HIVE_HOME/docker-compose.override.yml"
  if [ "$HIVE_EMBED" = "host" ] && plain_linux_engine; then
    cat > "$OVERRIDE" <<EOF
${OVERRIDE_MARK}
services:
  hive:
    extra_hosts: ["host.docker.internal:host-gateway"]
  hive-worker:
    extra_hosts: ["host.docker.internal:host-gateway"]
EOF
    ok "docker-compose.override.yml (host.docker.internal for a plain Linux engine)"
    warn "the host Ollama must listen beyond 127.0.0.1 for the containers to reach it: OLLAMA_HOST=0.0.0.0"
  elif [ -f "$OVERRIDE" ] && [ "$(head -1 "$OVERRIDE")" = "$OVERRIDE_MARK" ]; then
    rm -f "$OVERRIDE"
    ok "removed the docker-compose.override.yml an earlier run wrote"
  fi

  if [ -n "$SELF" ] && [ -f "$SELF" ]; then
    [ "$SELF" -ef "$HIVE_HOME/install.sh" ] || cp "$SELF" "$HIVE_HOME/install.sh"
  elif ! curl -fsSL -o "$HIVE_HOME/install.sh" "${HIVE_INSTALL_URL:-https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh}"; then
    warn "could not save install.sh into ${HIVE_HOME}"
  fi
  [ -f "$HIVE_HOME/install.sh" ] && chmod +x "$HIVE_HOME/install.sh" && ok "${HIVE_HOME}/install.sh (re-run it to change answers)"

  local host_ip="$HIVE_BIND"
  [ "$host_ip" = "0.0.0.0" ] && host_ip=127.0.0.1
  LOCAL_URL="http://${host_ip}:${HIVE_PORT}"
  PUBLIC_URL="$LOCAL_URL"
  [ "$HIVE_BIND" = "0.0.0.0" ] && PUBLIC_URL="http://${host_short:-localhost}:${HIVE_PORT}"

  if [ "$NO_UP" -eq 1 ]; then
    section "Done (--no-up)"
    info "start it: cd ${HIVE_HOME} && docker compose -p ${HIVE_PROJECT} up -d --wait, or re-run ${HIVE_HOME}/install.sh"
    return 0
  fi

  # --- start ------------------------------------------------------------------
  section "Start"
  dc pull --ignore-pull-failures --quiet || warn "pull failed; starting with the images already here"
  dc up -d --wait || die "the stack did not become healthy: docker compose -p ${HIVE_PROJECT} logs"
  local health
  health="$(curl -fsS "${LOCAL_URL}/health")" || die "${LOCAL_URL}/health does not answer"
  ok "health: ${health}"

  [ "$HIVE_EMBED" = "off" ] || pull_model "$(prev HIVE_EMBED_MODEL nomic-embed-text)"
  [ "$HIVE_DISTILL" = "ollama" ] && pull_model "$HIVE_DISTILL_MODEL"

  # --- tokens -------------------------------------------------------------------
  section "Tokens"
  if [ -z "$(read_env_key "$ENV_FILE" HIVE_WORKER_TOKEN)" ]; then
    local wtoken
    wtoken="$(mint "hive-worker-$(rand_hex 3)" hive-worker worker)" && [ -n "$wtoken" ] || die "could not mint the worker token"
    set_env_key "$ENV_FILE" HIVE_WORKER_TOKEN "$wtoken"
    dc up -d --wait hive-worker || die "hive-worker did not become healthy: docker compose -p ${HIVE_PROJECT} logs hive-worker"
    ok "worker token in .env; hive-worker restarted"
  else
    ok "worker token already in .env"
  fi

  local CURATOR_TOKEN="" curators
  curators="$(psql_count "select count(*) from instances where role='curator' and revoked_at is null")" \
    || die "cannot read the instances table"
  if [ "$curators" = "0" ]; then
    CURATOR_TOKEN="$(mint "$HIVE_CURATOR_NAME" "$HIVE_CURATOR_USER" curator)" && [ -n "$CURATOR_TOKEN" ] \
      || die "could not mint the curator token"
    ok "curator ${HIVE_CURATOR_NAME} (user ${HIVE_CURATOR_USER})"
  else
    ok "a curator token already exists; not minting another"
  fi

  local MEMBER_LINES="" m n tok members
  IFS=',' read -r -a members <<< "$HIVE_MEMBERS"
  for m in ${members[@]+"${members[@]}"}; do
    m="${m//[[:space:]]/}"
    [ -n "$m" ] || continue
    n="$(psql_count "select count(*) from instances where user_id='${m}' and revoked_at is null")" || die "cannot read the instances table"
    if [ "$n" != "0" ]; then ok "${m} already has a token; skipped"; continue; fi
    tok="$(mint "$m" "$m" member)" && [ -n "$tok" ] || die "could not mint a token for ${m}"
    MEMBER_LINES="${MEMBER_LINES}${m} ${tok}"$'\n'
    ok "member ${m}"
  done

  # --- fact agent credential ------------------------------------------------------
  local CRED_NOTE=""
  if [ "$HIVE_DISTILL" = "claude" ]; then
    local have
    have="$(psql_count "select count(*) from settings where key='agent_credential'" || echo 0)"
    if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      [ "$have" != "0" ] && ok "fact agent credential already set" || CRED_NOTE=settings
    else
      local bearer="$CURATOR_TOKEN"
      if [ -z "$bearer" ]; then
        section "Fact agent credential"
        info "No new curator token was minted, so setting the credential needs yours (empty = set it in Settings)."
        ask HIVE_CURATOR_TOKEN "Curator token" "" "" secret
        bearer="$HIVE_CURATOR_TOKEN"
      fi
      if [ -z "$bearer" ]; then CRED_NOTE=settings
      elif put_credential "$bearer"; then ok "fact agent credential set (stored encrypted in the Hive)"
      else warn "the Hive did not take the credential"; CRED_NOTE=settings; fi
    fi
  elif [ "$HIVE_DISTILL" = "skip" ]; then
    CRED_NOTE=settings
  fi

  # --- summary --------------------------------------------------------------------
  section "Hive is up"
  info "dashboard: ${PUBLIC_URL}/"
  info "install dir: ${HIVE_HOME} (project ${HIVE_PROJECT}); re-run ${HIVE_HOME}/install.sh to change answers"
  [ "$CRED_NOTE" = "settings" ] && info "fact agent: set its credential in the dashboard, Settings (sign in with the curator token)"
  if [ -n "$CURATOR_TOKEN" ]; then
    printf '\n  Curator token for %s (shown once, not stored anywhere else):\n    %s\n' "$HIVE_CURATOR_USER" "$CURATOR_TOKEN"
    person_block "${HIVE_CURATOR_USER} (curator)" "$CURATOR_TOKEN"
  fi
  while read -r m tok; do
    [ -n "$m" ] && person_block "$m" "$tok"
  done <<< "$MEMBER_LINES"
  printf '\n'
}

# --- join -------------------------------------------------------------------
# Where the hive plugin of Hive version $1 comes from: a release's hive-plugin.tar.gz (top dir hive/), or for a
# main build the repo tarball at that commit (<repo>-<sha>/plugins/hive). Anything else has no plugin to fetch.
plugin_source_url() {
  if [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then printf '%s\n' "${RELEASES}/download/v$1/hive-plugin.tar.gz"
  elif [[ "$1" =~ ^main-[0-9a-f]{7}$ ]]; then printf '%s\n' "https://codeload.github.com/${REPO}/tar.gz/${1#main-}"
  else die "no plugin download for Hive version '$1': re-run with --version <v> (a release X.Y.Z, or main-<sha7>)" 2; fi
}

cmd_join() {
  local url="" token="${HIVE_TOKEN:-}" force=0 version=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --url) url="${2:?--url needs a value}"; shift 2 ;;
      --token) token="${2:?--token needs a value}"; shift 2 ;;
      --version) version="${2:?--version needs a value}"; version=${version#v}; shift 2 ;;
      --force) force=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
  done
  [ -n "$url" ] || die "join needs --url <hive url>" 2
  while [ "${url%/}" != "$url" ]; do url=${url%/}; done
  local hh plugins target env_file
  hh="$(expand_dir "${HERMES_HOME:-~/.hermes}")"
  plugins="$hh/plugins"; target="$plugins/hive"; env_file="$hh/.env"

  # --- preflight ----------------------------------------------------------------
  section "Preflight (${url})"
  local health="" hive_version="" code cfg
  if ! command -v curl >/dev/null 2>&1; then die "curl not found: install curl, then re-run"; fi
  health="$(curl -fsS -m 10 "${url}/health" 2>/dev/null || true)"
  if [[ "$health" =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]; then
    hive_version="$(printf '%s' "$health" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')"
    ok "hive health (version ${hive_version:-unknown})"
  else
    bad "${url}/health does not answer ok" "${health:-no answer}; check the URL and that the Hive is up"
  fi
  if [ -z "$token" ]; then
    bad "no token" "pass --token <t> or set HIVE_TOKEN"
  else
    cfg="$(mktemp)"; chmod 600 "$cfg"
    printf 'header = "Authorization: Bearer %s"\n' "$token" > "$cfg"
    code="$(curl -sS -m 10 -K "$cfg" -o /dev/null -w '%{http_code}' "${url}/v1/status" 2>/dev/null || true)"
    rm -f "$cfg"
    if [ "$code" = "200" ]; then ok "token accepted (/v1/status)"
    else bad "/v1/status answered ${code:-nothing} with this token" "check the token (a revoked or mistyped one gets 401)"; fi
  fi
  if command -v hermes >/dev/null 2>&1; then ok "hermes"
  else bad "hermes not found on PATH" "install Hermes first, then re-run"; fi
  if [ -L "$target" ] && [ "$force" -ne 1 ]; then
    bad "${target} is a symlink (to $(readlink "$target"))" "it is probably a checkout; re-run with --force to replace the link (its target is kept)"
  else ok "plugin dir ${target}"; fi
  stop_if_failed

  # 0.0.1 is the server's built-in default, not a release: only an explicit --version 0.0.1 means it.
  if [ -z "$version" ]; then
    [ "$hive_version" != "0.0.1" ] || die "the Hive reports version 0.0.1 (not a release build): re-run with --version <v>" 2
    version=${hive_version:-unknown}
  fi
  local src
  src="$(plugin_source_url "$version")" || exit $?

  # --- plugin ---------------------------------------------------------------------
  section "Install (${hh})"
  JOIN_TGZ="$(mktemp)"; JOIN_STAGE=""
  trap 'rm -rf "$JOIN_TGZ" ${JOIN_STAGE:+"$JOIN_STAGE"}' EXIT
  curl -fsSL -o "$JOIN_TGZ" "$src" || die "cannot download the plugin: ${src}"
  mkdir -p "$plugins"
  JOIN_STAGE="$(mktemp -d "$plugins/.hive-join.XXXXXX")"   # same filesystem as the target, so mv is a rename
  mkdir "$JOIN_STAGE/x"
  tar -xzf "$JOIN_TGZ" -C "$JOIN_STAGE/x" || die "cannot unpack ${src}"
  local new="" d
  if [ -d "$JOIN_STAGE/x/hive" ]; then new="$JOIN_STAGE/x/hive"
  else for d in "$JOIN_STAGE"/x/*/plugins/hive; do [ -d "$d" ] && new=$d && break; done; fi
  [ -n "$new" ] || die "no hive/ or */plugins/hive in ${src}"
  if [ -L "$target" ]; then
    rm -f "$target"   # the link only; what it points to is left alone
    ok "removed the symlink ${target}"
  elif [ -e "$target" ]; then
    mv "$target" "$JOIN_STAGE/old"
  fi
  mv "$new" "$target"
  rm -rf "$JOIN_STAGE"; JOIN_STAGE=""
  ok "plugin ${target} (from ${src})"

  # --- .env -------------------------------------------------------------------------
  (umask 077; touch "$env_file")
  set_env_key "$env_file" HIVE_URL "$url"
  set_env_key "$env_file" HIVE_TOKEN "$token"
  chmod 600 "$env_file"
  ok "${env_file}: HIVE_URL, HIVE_TOKEN (mode 600)"

  # --- activate -----------------------------------------------------------------------
  HERMES_HOME="$hh" hermes config set memory.provider hive >/dev/null || die "hermes config set memory.provider hive failed"
  local status line provider_line="" first
  status="$(HERMES_HOME="$hh" hermes memory status 2>&1)" || die "hermes memory status failed: ${status}"
  # Only the active provider counts: a hive listed under "Installed plugins" is not the provider.
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*Provider: ]]; then provider_line=$line; break; fi
  done <<< "$status"
  first="${provider_line#*Provider:}"
  read -r first _ <<< "$first" || true
  [ "$first" = "hive" ] || die "hive is not the active memory provider (hermes memory status: ${provider_line:-no Provider line})"
  ok "memory provider: hive"

  section "Joined"
  info "Hermes at ${hh} uses the Hive at ${url}; start a new Hermes session to pick it up."
  printf '\n'
}

main() {
  local cmd=install
  case "${1:-}" in
    install) shift ;;
    join) cmd=join; shift ;;
    -*|"") ;;
    *) printf 'unknown command: %s (install or join)\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  "cmd_${cmd}" "$@"
}

main "$@"
