#!/bin/sh
# Hive's nightly pg_dump, run by the compose `backup` service. Both compose files embed a copy of this file as
# HIVE_BACKUP_SH (every $ written $$); scripts/backup.test.sh checks the copies match it.
#
#   loop            sleep until HIVE_BACKUP_TIME (default 03:00, in TZ, default UTC), run `once`, repeat;
#                   HIVE_BACKUPS=off idles instead
#   once            dump to /backups/hive-YYYYMMDD-HHMM.dump (and /backups-copy when HIVE_BACKUP_COPY_DIR is
#                   set), then apply retention to both
#   keep YYYYMMDD   file names on stdin -> the ones retention keeps on that date
#   newest          "<age seconds> <file>" of the newest dump, or "none"
#   restore <file|latest> <db>
#                   pg_restore a dump in /backups (latest = the newest) into a new database <db> (createdb fails if
#                   it exists, so nothing is overwritten); <db> = hive restores over the live one (--clean)
#   counts <db>     "<table> <rows>" for every table in <db>'s public schema, sorted
#
# Any caller: docker compose run --rm --no-deps -T backup <subcommand>
set -u

BACKUPS=${BACKUPS:-/backups}
BACKUPS_COPY=${BACKUPS_COPY:-/backups-copy}
NAME_RE='^hive-[0-9]{8}-[0-9]{4}\.dump$'
export LC_ALL=C

log() { printf '%s backup: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; }

# YYYYMMDD -> days since 1970-01-01 (days_from_civil), so no `date -d` is needed.
day_number() {
  y=${1%????}; m=${1#????}; m=${m%??}; d=${1#??????}
  m=${m#0}; d=${d#0}
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$((y / 400)); yoe=$((y - era * 400))
  doy=$(( (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1 ))
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $((era * 146097 + doe - 719468))
}

# Keep the newest dump of each of the 7 days ending on $1, of each Sunday among the 28 days ending on $1, and the
# newest dump overall. Names that aren't exactly hive-YYYYMMDD-HHMM.dump are not printed (and never deleted).
cmd_keep() {
  case "${1:-}" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "keep: want a date YYYYMMDD" >&2; return 2 ;; esac
  today=$(day_number "$1")
  grep -E "$NAME_RE" | sort -r | {
    first=1 seen=" "
    while IFS= read -r f; do
      date=${f#hive-}; date=${date%%-*}
      keep=$first; first=0
      case "$seen" in *" $date "*) ;; *)
        seen="$seen$date "
        n=$(day_number "$date"); age=$((today - n))
        if [ "$age" -ge 0 ] && [ "$age" -lt 7 ]; then keep=1
        elif [ "$age" -ge 0 ] && [ "$age" -lt 28 ] && [ $(((n + 4) % 7)) -eq 0 ]; then keep=1; fi
      esac
      [ "$keep" = 1 ] && printf '%s\n' "$f"
    done
  }
  return 0
}

# Delete the dumps in $1 that retention doesn't keep today.
prune() {
  list=$(ls -1A "$1") || return 1
  keep=$(printf '%s\n' "$list" | cmd_keep "$(date +%Y%m%d)")
  [ -n "$keep" ] || return 0
  printf '%s\n' "$list" | grep -E "$NAME_RE" | while IFS= read -r f; do
    case "
$keep
" in *"
$f
"*) ;; *) rm -f "$1/$f" && log "pruned $1/$f" ;; esac
  done
}

# A subshell, so the umask and the trap end with it.
cmd_once() (
  umask 077
  start=$(date +%s)
  name="hive-$(date +%Y%m%d-%H%M).dump"
  tmp="$BACKUPS/.$name.tmp" ctmp=""
  trap 'rm -f "$tmp" ${ctmp:+"$ctmp"}' EXIT
  trap 'exit 1' INT TERM
  if ! pg_dump -Fc -h postgres -U hive -d hive -f "$tmp"; then
    log "pg_dump failed; no dump written"
    exit 1
  fi
  mv "$tmp" "$BACKUPS/$name" || { log "cannot rename $tmp"; exit 1; }
  rc=0
  if [ -n "${HIVE_BACKUP_COPY_DIR:-}" ]; then
    ctmp="$BACKUPS_COPY/.$name.tmp"
    if cp "$BACKUPS/$name" "$ctmp" && mv "$ctmp" "$BACKUPS_COPY/$name"; then
      prune "$BACKUPS_COPY" || rc=1
    else
      log "cannot copy $name into $BACKUPS_COPY"; rc=1
    fi
  fi
  prune "$BACKUPS" || rc=1
  size=$(wc -c < "$BACKUPS/$name" | tr -d ' ')
  log "wrote $BACKUPS/$name ($size bytes, $(($(date +%s) - start)) s)${HIVE_BACKUP_COPY_DIR:+, copied to $BACKUPS_COPY}"
  exit "$rc"
)

cmd_newest() {
  list=$(ls -1A "$BACKUPS") || return 1
  f=$(printf '%s\n' "$list" | grep -E "$NAME_RE" | sort | tail -n 1)
  [ -n "$f" ] || { echo none; return 0; }
  mtime=$(stat -c %Y "$BACKUPS/$f" 2>/dev/null || stat -f %m "$BACKUPS/$f") || return 1
  echo "$(($(date +%s) - mtime)) $f"
}

db_name_ok() {
  printf '%s\n' "$1" | grep -Eq '^[a-z_][a-z0-9_]*$' || { echo "'$1' is not a database name ([a-z_][a-z0-9_]*)" >&2; return 1; }
}

cmd_restore() {
  file=${1:-} db=${2:-}
  [ -n "$file" ] && [ -n "$db" ] || { echo "restore: want <file|latest> <db>" >&2; return 2; }
  db_name_ok "$db" || return 2
  if [ "$file" = latest ]; then
    list=$(ls -1A "$BACKUPS") || return 1
    file=$(printf '%s\n' "$list" | grep -E "$NAME_RE" | sort | tail -n 1)
    [ -n "$file" ] || { log "no dump in $BACKUPS to restore"; return 1; }
  fi
  case "$file" in */*|.*) echo "restore: '$file' is not a file name in $BACKUPS" >&2; return 2 ;; esac
  [ -f "$BACKUPS/$file" ] || { log "no $BACKUPS/$file"; return 1; }
  log "restoring $BACKUPS/$file into database $db"
  if [ "$db" = hive ]; then
    pg_restore --no-owner --clean --if-exists -h postgres -U hive -d hive "$BACKUPS/$file" \
      || { log "pg_restore of $file into hive failed"; return 1; }
  else
    createdb -h postgres -U hive "$db" || { log "cannot create database $db (does it exist already?)"; return 1; }
    pg_restore --no-owner -h postgres -U hive -d "$db" "$BACKUPS/$file" \
      || { log "pg_restore of $file into $db failed"; return 1; }
  fi
  log "restored $BACKUPS/$file into database $db"
}

cmd_counts() {
  db=${1:-}
  db_name_ok "$db" || return 2
  tables=$(psql -X -At -h postgres -U hive -d "$db" -c "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'") \
    || return 1
  for t in $(printf '%s\n' "$tables" | sort); do
    n=$(psql -X -At -h postgres -U hive -d "$db" -c "select count(*) from public.\"$t\"") || return 1
    printf '%s %s\n' "$t" "$n"
  done
}

# Seconds from now until the next $1 (HH:MM) on this clock; a time that is now or past means tomorrow's.
seconds_until() {
  h=${1%:*}; m=${1#*:}; h=${h#0}; m=${m#0}
  set -- $(date '+%H %M %S')
  now=$((${1#0} * 3600 + ${2#0} * 60 + ${3#0}))
  s=$((h * 3600 + m * 60 - now))
  [ "$s" -gt 0 ] || s=$((s + 86400))
  echo "$s"
}

cmd_loop() {
  if [ "${HIVE_BACKUPS:-on}" = off ]; then
    log "backups off"
    exec sleep infinity
  fi
  at=${HIVE_BACKUP_TIME:-03:00}
  case "$at" in [01][0-9]:[0-5][0-9]|2[0-3]:[0-5][0-9]) ;; *) log "HIVE_BACKUP_TIME='$at' is not HH:MM; using 03:00"; at=03:00 ;; esac
  log "nightly at $at (TZ ${TZ:-UTC}) into $BACKUPS"
  while :; do
    sleep "$(seconds_until "$at")"
    cmd_once || log "backup failed; next one at $at"
  done
}

case "${1:-}" in
  loop) cmd_loop ;;
  once) cmd_once ;;
  keep) shift; cmd_keep "$@" ;;
  newest) cmd_newest ;;
  restore) shift; cmd_restore "$@" ;;
  counts) shift; cmd_counts "$@" ;;
  *) echo "usage: backup.sh loop|once|keep <YYYYMMDD>|newest|restore <file|latest> <db>|counts <db>" >&2; exit 2 ;;
esac
