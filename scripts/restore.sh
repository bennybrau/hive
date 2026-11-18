#!/usr/bin/env bash
#
# Restore a Hive backup (the backup service's `restore`), then compare row counts with the live database.
#
#   scripts/restore.sh <file|latest> [--into <db>] [--yes] [--dir <install dir>] [--project <name>]
#
# <file> is a dump name in the backups (hive-YYYYMMDD-HHMM.dump); latest is the newest. By default it restores into
# a new database hive_restore_<YYYYMMDDHHMMSS>, leaving the live one alone (the drill), and prints how to drop it.
# --into hive --yes restores over the live database: hive and hive-worker are stopped meanwhile and started again
# even if the restore fails. The install and project are found as backup-now.sh finds them, and it refuses the same.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"

die() { printf '%s\n' "$1" >&2; exit "${2:-1}"; }
bad() { printf '  ✗ %s\n' "$1" >&2; [ -n "${2:-}" ] && printf '      %s\n' "$2" >&2; return 0; }

usage() { sed -n '3,10p' "$SELF" | sed 's/^# \{0,1\}//'; }

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
file="" into="" yes=0 dir="" project=""
while [ $# -gt 0 ]; do
  case "$1" in
    --into) into="${2:?--into needs a value}"; shift 2 ;;
    --yes) yes=1; shift ;;
    --dir) dir="${2:?--dir needs a value}"; shift 2 ;;
    --project) project="${2:?--project needs a value}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    -*) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$file" ] || { printf 'one dump at a time: %s\n' "$1" >&2; exit 2; }; file=$1; shift ;;
  esac
done
[ -n "$file" ] || { usage >&2; exit 2; }
into=${into:-hive_restore_$(date +%Y%m%d%H%M%S)}
[[ "$into" =~ ^[a-z_][a-z0-9_]*$ ]] || die "--into '${into}' is not a database name ([a-z_][a-z0-9_]*)" 2
if [ "$into" = hive ] && [ "$yes" != 1 ]; then
  die "--into hive replaces the live database (hive and hive-worker are stopped meanwhile); add --yes to do it" 2
fi

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

dc() { docker compose --project-directory "$HIVE_HOME" -p "$HIVE_PROJECT" "$@"; }

if [ "$into" = hive ]; then
  restart() {
    dc up -d --wait hive hive-worker && return 0
    bad "could not start hive and hive-worker again" "docker compose -p ${HIVE_PROJECT} up -d --wait"
    return 1
  }
  trap 'rc=$?; restart || true; exit $rc' EXIT
  dc stop hive hive-worker
  dc run --rm --no-deps -T backup restore "$file" hive || die "restore failed"
  trap - EXIT
  restart || exit 1
else
  dc run --rm --no-deps -T backup restore "$file" "$into" || die "restore failed"
fi

restored="$(dc run --rm --no-deps -T backup counts "$into")" || die "cannot count the rows in ${into}"
if [ "$into" = hive ]; then
  printf '%s\n' "$restored" | awk '
    BEGIN { printf "%-28s %10s\n", "table", "restored" }
    NF { printf "%-28s %10s\n", $1, $2; n++ }
    END { printf "%d tables\n", n }'
  exit 0
fi
live="$(dc run --rm --no-deps -T backup counts hive)" || die "cannot count the rows in hive"
# table  restored  live, sorted, * on the rows that differ ("-" = no such table there)
rows="$({ printf '%s\n' "$restored" | sed 's/^/r /'; printf '%s\n' "$live" | sed 's/^/l /'; } | awk '
  NF == 3 { t[$2] = 1; if ($1 == "r") r[$2] = $3; else l[$2] = $3 }
  END {
    for (k in t) {
      a = (k in r) ? r[k] : "-"; b = (k in l) ? l[k] : "-"
      printf "%-28s %10s %10s%s\n", k, a, b, (a == b ? "" : "  *")
    }
  }' | LC_ALL=C sort)"
printf '%-28s %10s %10s\n' table restored live
printf '%s\n' "$rows"
printf '%d tables, %d differ (live db keeps changing; informational)\n' \
  "$(printf '%s\n' "$rows" | grep -c .)" "$(printf '%s\n' "$rows" | grep -c '\*$')"
echo
echo "Restored into database ${into}. Drop it when done:"
echo "  docker compose --project-directory ${HIVE_HOME} -p ${HIVE_PROJECT} exec -T postgres dropdb -U hive ${into}"
