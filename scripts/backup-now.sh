#!/usr/bin/env bash
#
# Take a Hive backup now (the nightly one's `once`), into the same place and with the same retention.
#
#   scripts/backup-now.sh [--dir <install dir>] [--project <name>]
#
# The install is --dir, else $HIVE_HOME, else this script's dir if it holds .env, else the repo root; the project
# is --project, else HIVE_PROJECT in its .env, else hive. Refuses when that project's containers run from another
# dir, or when docker can't list them.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"

die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
bad() { printf '  ✗ %s\n' "$1" >&2; [ -n "${2:-}" ] && printf '      %s\n' "$2" >&2; return 0; }

usage() { sed -n '3,9p' "$SELF" | sed 's/^# \{0,1\}//'; }

read_env_key() { # $1 = file, $2 = key ; prints the last value found (blank if none)
  local file=$1 key=$2 line val=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [ "${line%%=*}" = "$key" ] && [ "${line#"$key"=}" != "$line" ] && val="${line#"$key"=}"
  done < "$file"
  printf '%s' "$val"
}

# As install.sh: ~ and relative paths -> absolute and clean, to compare with the containers' working_dir.
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

# As install.sh: returns 1 when project $1 runs from another dir than $2, or when docker can't list it.
check_project_owner() {
  local project=$1 dir=$2 wd wds err
  err="$(mktemp)"
  if ! wds="$(docker ps -a --filter "label=com.docker.compose.project=${project}" \
      --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>"$err")"; then
    bad "cannot list containers for project ${project}" "$(cat "$err")"
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
  while IFS= read -r wd; do
    [ -n "$wd" ] || continue
    if [ "$wd" != "$dir" ]; then
      bad "compose project '${project}' already runs from ${wd}" "that is another Hive; name this one with --project <name>"
      return 1
    fi
  done <<EOF
$wds
EOF
  return 0
}

dir="" project=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="${2:?--dir needs a value}"; shift 2 ;;
    --project) project="${2:?--project needs a value}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

self_dir="$(cd -- "$(dirname "$SELF")" && pwd)"
dir=${dir:-${HIVE_HOME:-}}
if [ -z "$dir" ]; then
  if [ -f "$self_dir/.env" ]; then dir=$self_dir; else dir="$self_dir/.."; fi
fi
HIVE_HOME="$(expand_dir "$dir")"
[ -f "$HIVE_HOME/.env" ] || die "no Hive at ${HIVE_HOME} (no .env): pass --dir <install dir>" 2
HIVE_PROJECT=${project:-$(read_env_key "$HIVE_HOME/.env" HIVE_PROJECT)}
HIVE_PROJECT=${HIVE_PROJECT:-hive}
[[ "$HIVE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "project '${HIVE_PROJECT}' is not a valid compose project name" 2

check_project_owner "$HIVE_PROJECT" "$HIVE_HOME" \
  || die "not touching project ${HIVE_PROJECT}: cannot confirm it belongs to ${HIVE_HOME} (see above)"

docker compose --project-directory "$HIVE_HOME" -p "$HIVE_PROJECT" run --rm --no-deps -T backup once
