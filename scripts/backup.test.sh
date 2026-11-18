#!/usr/bin/env bash
# Tests for scripts/backup.sh, scripts/backup-now.sh and scripts/restore.sh. No Docker or Postgres needed.
#
#   bash scripts/backup.test.sh
#
# backup.sh runs under sh with BACKUPS/BACKUPS_COPY pointed at temp dirs and fakes on PATH: `pg_dump` (logs its argv,
# writes FAKE_DUMP into -f; FAKE_PGDUMP_FAIL=1 writes half a dump and fails), `cp` (logs its argv), `sleep` (logs its argv; the second call
# stops the loop), `createdb` (FAKE_DB_EXISTS=1 fails), `pg_restore` (logs its argv), `psql` (answers the table list
# and the counts from FAKE_TABLES "name=rows ...") and `docker` for backup-now.sh and restore.sh (FAKE_PS_FAIL,
# FAKE_PS_PROJECT + FAKE_PS_WORKDIR, as install.test.sh; `run ... backup counts <db>` answers FAKE_COUNTS_LIVE for
# hive, else FAKE_COUNTS_RESTORED; FAKE_RESTORE_FAIL=1 fails `run ... backup restore`).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_SH="$REPO_ROOT/scripts/backup.sh"
BACKUP_NOW="$REPO_ROOT/scripts/backup-now.sh"

PASS=0
FAIL=0
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
pass() { PASS=$((PASS + 1)); }
assert_contains() { case "$1" in *"$2"*) pass ;; *) fail "$3 (expected to find: $2)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "$3 (did not expect to find: $2)" ;; *) pass ;; esac; }
assert_eq() { [ "$1" = "$2" ] && pass || fail "$3 (got '$1', want '$2')"; }
assert_file() { [ -e "$1" ] && pass || fail "$2 (missing: $1)"; }
assert_no_file() { [ -e "$1" ] && fail "$2 (exists: $1)" || pass; }

TMP="$(cd "$(mktemp -d)" && pwd)"
FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
trap 'rm -rf "$TMP"' EXIT
export FAKE_LOG="$TMP/argv.log"

cat > "$FAKE_BIN/pg_dump" <<'EOF'
#!/bin/sh
printf 'pg_dump %s\n' "$*" >> "$FAKE_LOG"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-f" ] && out=$a; prev=$a; done
# what the dump dir holds while the dump runs
printf 'during: %s\n' "$(ls -A "$(dirname "$out")" | tr '\n' ' ')" >> "$FAKE_LOG"
if [ "${FAKE_PGDUMP_FAIL:-}" = 1 ]; then printf 'PGDMP-half' > "$out"; echo "pg_dump: error: connection failed" >&2; exit 1; fi
printf '%s' "${FAKE_DUMP:-PGDMP-fake-dump}" > "$out"
EOF
cat > "$FAKE_BIN/sleep" <<'EOF'
#!/bin/sh
printf 'sleep %s\n' "$*" >> "$FAKE_LOG"
[ "$(grep -c '^sleep ' "$FAKE_LOG")" -ge 2 ] && kill -TERM "$PPID"
exit 0
EOF
cat > "$FAKE_BIN/cp" <<'EOF'
#!/bin/sh
printf 'cp %s\n' "$*" >> "$FAKE_LOG"
PATH=/usr/bin:/bin exec cp "$@"
EOF
cat > "$FAKE_BIN/createdb" <<'EOF'
#!/bin/sh
printf 'createdb %s\n' "$*" >> "$FAKE_LOG"
[ "${FAKE_DB_EXISTS:-}" = 1 ] && { echo "createdb: error: database creation failed: ERROR:  database already exists" >&2; exit 1; }
exit 0
EOF
cat > "$FAKE_BIN/pg_restore" <<'EOF'
#!/bin/sh
printf 'pg_restore %s\n' "$*" >> "$FAKE_LOG"
exit 0
EOF
cat > "$FAKE_BIN/psql" <<'EOF'
#!/bin/sh
printf 'psql %s\n' "$*" >> "$FAKE_LOG"
for a in "$@"; do q=$a; done
case "$q" in
  *information_schema.tables*) for t in $FAKE_TABLES; do echo "${t%%=*}"; done ;;
  *count*) for t in $FAKE_TABLES; do case "$q" in *"public.\"${t%%=*}\""*) echo "${t#*=}" ;; esac; done ;;
esac
EOF
cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  ps)
    [ "${FAKE_PS_FAIL:-}" = 1 ] && { echo "permission denied while trying to connect to the Docker daemon" >&2; exit 1; }
    case "$*" in *"label=com.docker.compose.project=${FAKE_PS_PROJECT:-none} "*) echo "${FAKE_PS_WORKDIR:-}" ;; esac
    exit 0 ;;
esac
case "$*" in
  *" backup restore "*) [ "${FAKE_RESTORE_FAIL:-}" = 1 ] && { echo "pg_restore: error: could not connect" >&2; exit 1; } ;;
  *" backup counts hive") printf '%s\n' "${FAKE_COUNTS_LIVE:-}" ;;
  *" backup counts "*) printf '%s\n' "${FAKE_COUNTS_RESTORED:-}" ;;
esac
exit 0
EOF
chmod +x "$FAKE_BIN"/*

# backup.sh with the fakes, dumps in $B (and $C); extra env first
B="$TMP/backups"; C="$TMP/copy"
bk() { env PATH="$FAKE_BIN:$PATH" BACKUPS="$B" BACKUPS_COPY="$C" TZ=UTC PGPASSWORD=pw-SECRET "$@" < /dev/null; }
reset() { rm -rf "$B" "$C"; mkdir -p "$B" "$C"; : > "$FAKE_LOG"; }

# keep DATE NAMES... -> the kept names, space separated, sorted
keep() { local d=$1; shift; printf '%s\n' "$@" | sh "$BACKUP_SH" keep "$d" | sort | tr '\n' ' ' | sed 's/ $//'; }
days() { # $1..$2 (YYYYMMDD, same month) at HHMM $3 -> names
  local d; for ((d = $1; d <= $2; d++)); do printf 'hive-%s-%s.dump\n' "$d" "$3"; done
}

# --- retention: keep ---------------------------------------------------------------------------
# 2026-11-18 is a Wednesday; the Sundays before it are 15, 8 and 1 Nov, 25 and 18 Oct.
all="$(days 20261101 20261118 0300)"
# shellcheck disable=SC2086
got="$(keep 20261118 $all)"
assert_eq "$got" "hive-20261101-0300.dump hive-20261108-0300.dump hive-20261112-0300.dump hive-20261113-0300.dump hive-20261114-0300.dump hive-20261115-0300.dump hive-20261116-0300.dump hive-20261117-0300.dump hive-20261118-0300.dump" \
  "daily dumps: the 7 days ending today, plus the Sundays"
assert_contains " $got " " hive-20261112-0300.dump " "6 days ago is kept"
assert_not_contains " $got " " hive-20261111-0300.dump " "7 days ago (a Wednesday) is not"

got="$(keep 20261118 hive-20261004-0300.dump hive-20261011-0300.dump hive-20261018-0300.dump hive-20261025-0300.dump \
  hive-20261101-0300.dump hive-20261108-0300.dump hive-20261115-0300.dump hive-20261117-0300.dump)"
assert_eq "$got" "hive-20261025-0300.dump hive-20261101-0300.dump hive-20261108-0300.dump hive-20261115-0300.dump hive-20261117-0300.dump" \
  "Sundays: the 4 within 28 days (25 Oct, 24 days ago, in; 18 Oct, 31 days ago, out)"
got="$(keep 20261115 hive-20261018-0300.dump hive-20261025-0300.dump hive-20261101-0300.dump hive-20261108-0300.dump hive-20261115-0300.dump)"
assert_eq "$got" "hive-20261025-0300.dump hive-20261101-0300.dump hive-20261108-0300.dump hive-20261115-0300.dump" \
  "on a Sunday: today and the 3 before it, not the one 28 days back"
got="$(keep 20261118 hive-20261111-0300.dump hive-20261110-0300.dump hive-20261118-0300.dump)"
assert_eq "$got" "hive-20261118-0300.dump" "weekdays older than 7 days go"

got="$(keep 20261118 hive-20261118-0300.dump hive-20261118-1412.dump hive-20261118-0959.dump \
  hive-20261117-0300.dump hive-20261117-2359.dump hive-20261115-0100.dump hive-20261115-2300.dump)"
assert_eq "$got" "hive-20261115-2300.dump hive-20261117-2359.dump hive-20261118-1412.dump" "several a day: the newest of each day"

got="$(keep 20261118 hive-20260801-0300.dump hive-20260715-0300.dump hive-20260705-0300.dump)"
assert_eq "$got" "hive-20260801-0300.dump" "a month gap: only the newest overall"
got="$(keep 20261118 hive-20260801-0300.dump hive-20261118-0300.dump)"
assert_eq "$got" "hive-20261118-0300.dump" "an old dump goes once a newer one exists"
assert_eq "$(keep 20261118)" "" "no dumps => nothing"

got="$(keep 20261118 notes.txt hive-20261118-0300.dump.tmp .hive-20261118-0300.dump.tmp hive-2026111-0300.dump \
  xhive-20261117-0300.dump hive-20261117-0300.dumpx "hive-20261117-0300.dump " hive-20261116-0300.dump)"
assert_eq "$got" "hive-20261116-0300.dump" "only exact hive-YYYYMMDD-HHMM.dump names count"

# across a year end and a leap day (2025-12-28 is a Sunday)
# shellcheck disable=SC2046
got="$(keep 20260103 $(days 20251226 20251231 0300) $(days 20260101 20260103 0300))"
assert_eq "$got" "hive-20251228-0300.dump hive-20251229-0300.dump hive-20251230-0300.dump hive-20251231-0300.dump hive-20260101-0300.dump hive-20260102-0300.dump hive-20260103-0300.dump" \
  "the 7 days across a year end"
got="$(keep 20240306 hive-20240228-0300.dump hive-20240229-0300.dump hive-20240301-0300.dump)"
assert_eq "$got" "hive-20240229-0300.dump hive-20240301-0300.dump" "2024-02-29 is 6 days before 2024-03-06"
got="$(keep 20240306 hive-20240225-0300.dump hive-20240218-0300.dump hive-20240211-0300.dump hive-20240204-0300.dump hive-20240306-0300.dump)"
assert_eq "$got" "hive-20240211-0300.dump hive-20240218-0300.dump hive-20240225-0300.dump hive-20240306-0300.dump" \
  "Sundays across February of a leap year (4 Feb is 31 days back)"

out="$(printf 'x\n' | sh "$BACKUP_SH" keep 2026-11-18 2>&1)"; code=$?
assert_eq "$code" "2" "keep with a bad date exits 2"
out="$(sh "$BACKUP_SH" frobnicate 2>&1)"; code=$?
assert_eq "$code" "2" "an unknown subcommand exits 2"

# --- once: temp + rename, mode 600, retention, the copy ------------------------------------------
reset
today="$(TZ=UTC date +%Y%m%d)"
echo old > "$B/hive-20200101-0300.dump"; echo mine > "$B/notes.txt"; echo x > "$B/hive-20200101-0300.dump.bak"
out="$(bk sh "$BACKUP_SH" once 2>&1)"; code=$?
assert_eq "$code" "0" "once succeeds"
name="$(cd "$B" && ls hive-"$today"-*.dump 2>/dev/null)"
assert_file "$B/$name" "once writes hive-<today>-HHMM.dump"
assert_eq "$(cat "$B/$name" 2>/dev/null)" "PGDMP-fake-dump" "the dump holds what pg_dump wrote"
assert_eq "$(stat -c '%a' "$B/$name" 2>/dev/null || stat -f '%Lp' "$B/$name")" "600" "the dump is mode 600"
assert_contains "$(cat "$FAKE_LOG")" "pg_dump -Fc -h postgres -U hive -d hive -f $B/.$name.tmp" "pg_dump writes a temp name in the dump dir"
assert_eq "$(grep '^during:' "$FAKE_LOG")" "during: hive-20200101-0300.dump hive-20200101-0300.dump.bak notes.txt " \
  "while pg_dump runs, the final name doesn't exist yet"
assert_eq "$(ls -A "$B" | grep -c '\.tmp$')" "0" "no temp file left"
assert_no_file "$B/hive-20200101-0300.dump" "retention removes the old dump"
assert_file "$B/notes.txt" "retention leaves a foreign file alone"
assert_file "$B/hive-20200101-0300.dump.bak" "retention leaves a near-miss name alone"
assert_contains "$out" "wrote $B/$name (15 bytes, " "once logs the file, its size and the seconds"
assert_eq "$(printf '%s\n' "$out" | grep -c .)" "2" "once logs one line, plus one per pruned file"
assert_not_contains "$out" "pw-SECRET" "the password is never logged"
assert_eq "$(ls -A "$C")" "" "no HIVE_BACKUP_COPY_DIR => no copy"

reset
echo old > "$C/hive-20200101-0300.dump"
out="$(bk HIVE_BACKUP_COPY_DIR=/srv/offbox sh "$BACKUP_SH" once 2>&1)"; code=$?
assert_eq "$code" "0" "once with a copy dir succeeds"
name="$(cd "$B" && ls hive-"$today"-*.dump 2>/dev/null)"
cmp -s "$B/$name" "$C/$name" && pass || fail "the copy is the dump"
assert_eq "$(ls -A "$C")" "$name" "the copy dir: retention applied, no temp file"
assert_contains "$(cat "$FAKE_LOG")" "cp $B/$name $C/.$name.tmp" "the copy goes to a temp name first"
assert_contains "$out" "copied to $C" "once logs the copy"

reset
out="$(bk FAKE_PGDUMP_FAIL=1 sh "$BACKUP_SH" once 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "a failed pg_dump => once exits non-zero"
assert_eq "$(ls -A "$B")" "" "a failed pg_dump leaves nothing (the half-written temp file is removed)"
assert_contains "$out" "pg_dump failed" "a failed pg_dump is logged"

# --- newest --------------------------------------------------------------------------------------
reset
assert_eq "$(bk sh "$BACKUP_SH" newest)" "none" "newest on an empty dir => none"
echo x > "$B/notes.txt"
assert_eq "$(bk sh "$BACKUP_SH" newest)" "none" "newest ignores foreign files"
echo a > "$B/hive-20261117-0300.dump"; echo b > "$B/hive-20261118-0300.dump"; echo c > "$B/hive-20261116-2300.dump"
out="$(bk sh "$BACKUP_SH" newest)"
[[ "$out" =~ ^[0-9]+\ hive-20261118-0300\.dump$ ]] && pass || fail "newest => '<age> hive-20261118-0300.dump' (got '$out')"
out="$(bk BACKUPS="$TMP/nowhere" sh "$BACKUP_SH" newest 2>/dev/null)"; code=$?
[ "$code" -ne 0 ] && pass || fail "newest on a missing dir exits non-zero"

# BSD stat (macOS): rejects -c, answers -f %m; the fake answers -f %m through the real stat (GNU or BSD)
BSD_BIN="$TMP/bsd-bin"; mkdir -p "$BSD_BIN"
REAL_STAT="$(command -v stat)"
cat > "$BSD_BIN/stat" <<EOF
#!/bin/sh
printf 'stat %s\n' "\$*" >> "\$FAKE_LOG"
case "\$1" in
  -f) [ "\$2" = %m ] || { echo "fake BSD stat: only -f %m" >&2; exit 1; }; shift 2
      $REAL_STAT -c %Y "\$@" 2>/dev/null || exec $REAL_STAT -f %m "\$@" ;;
  *) echo "stat: illegal option -- \${1#-}" >&2; echo "usage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]" >&2; exit 1 ;;
esac
EOF
chmod +x "$BSD_BIN/stat"
: > "$FAKE_LOG"
out="$(bk PATH="$BSD_BIN:$FAKE_BIN:$PATH" sh "$BACKUP_SH" newest 2>&1)"
[[ "$out" =~ ^[0-9]+\ hive-20261118-0300\.dump$ ]] && pass || fail "newest with BSD stat => '<age> hive-20261118-0300.dump' (got '$out')"
assert_contains "$(cat "$FAKE_LOG")" "stat -f %m $B/hive-20261118-0300.dump" "newest falls back to stat -f %m"

# --- restore and counts --------------------------------------------------------------------------
reset
echo a > "$B/hive-20261117-0300.dump"; echo b > "$B/hive-20261118-0300.dump"; echo c > "$B/hive-20261116-2300.dump"
echo x > "$B/hive-20261119-0300.dump.bak"
out="$(bk sh "$BACKUP_SH" restore latest hive_restore_1 2>&1)"; code=$?
assert_eq "$code" "0" "restore latest into a new db succeeds"
assert_eq "$(grep -E '^(createdb|pg_restore) ' "$FAKE_LOG")" "createdb -h postgres -U hive hive_restore_1
pg_restore --no-owner -h postgres -U hive -d hive_restore_1 $B/hive-20261118-0300.dump" \
  "restore latest: createdb, then pg_restore of the newest dump, no --clean"
assert_contains "$out" "restoring $B/hive-20261118-0300.dump into database hive_restore_1" "restore logs the file it used"
assert_not_contains "$out" "pw-SECRET" "restore never logs the password"

: > "$FAKE_LOG"
out="$(bk FAKE_DB_EXISTS=1 sh "$BACKUP_SH" restore hive-20261117-0300.dump hive_restore_1 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "restore into an existing db => exits non-zero"
assert_not_contains "$(cat "$FAKE_LOG")" "pg_restore" "restore into an existing db => no pg_restore"
assert_contains "$out" "cannot create database hive_restore_1" "restore into an existing db => says so"

: > "$FAKE_LOG"
out="$(bk sh "$BACKUP_SH" restore hive-20261117-0300.dump hive 2>&1)"; code=$?
assert_eq "$code" "0" "restore over hive succeeds"
assert_eq "$(grep -E '^(createdb|pg_restore) ' "$FAKE_LOG")" \
  "pg_restore --no-owner --clean --if-exists -h postgres -U hive -d hive $B/hive-20261117-0300.dump" \
  "restore over hive: pg_restore --clean --if-exists, no createdb"

for f in ../hive-20261117-0300.dump /etc/passwd .hive-20261118-0300.dump.tmp; do
  : > "$FAKE_LOG"
  out="$(bk sh "$BACKUP_SH" restore "$f" hive_restore_1 2>&1)"; code=$?
  assert_eq "$code" "2" "restore '$f' (not a plain name) exits 2"
  assert_eq "$(cat "$FAKE_LOG")" "" "restore '$f' => no createdb or pg_restore"
done
out="$(bk sh "$BACKUP_SH" restore hive-20200101-0300.dump hive_restore_1 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "restore of a missing dump exits non-zero"
assert_eq "$(cat "$FAKE_LOG")" "" "restore of a missing dump => no createdb or pg_restore"
out="$(bk sh "$BACKUP_SH" restore latest 'x; drop' 2>&1)"; code=$?
assert_eq "$code" "2" "restore into a bad db name exits 2"
out="$(bk sh "$BACKUP_SH" restore latest 2>&1)"; code=$?
assert_eq "$code" "2" "restore without a db exits 2"
reset
out="$(bk sh "$BACKUP_SH" restore latest hive_restore_1 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "restore latest with no dumps exits non-zero"
assert_eq "$(cat "$FAKE_LOG")" "" "restore latest with no dumps => no createdb"

: > "$FAKE_LOG"
out="$(bk FAKE_TABLES="facts=12 anchors=3 episodes=0" sh "$BACKUP_SH" counts hive_restore_1 2>&1)"; code=$?
assert_eq "$code" "0" "counts succeeds"
assert_eq "$out" "anchors 3
episodes 0
facts 12" "counts: '<table> <rows>', sorted"
assert_contains "$(cat "$FAKE_LOG")" "psql -X -At -h postgres -U hive -d hive_restore_1 -c select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'" \
  "counts lists the public base tables"
out="$(bk sh "$BACKUP_SH" counts Hive 2>&1)"; code=$?
assert_eq "$code" "2" "counts with a bad db name exits 2"

# seconds_until, extracted from backup.sh, with `date '+%H %M %S'` answering FAKE_CLOCK (HH:MM:SS)
CLOCK_BIN="$TMP/clock-bin"; mkdir -p "$CLOCK_BIN"
cat > "$CLOCK_BIN/date" <<EOF
#!/bin/sh
[ "\$*" = "+%H %M %S" ] && { echo "\$FAKE_CLOCK" | tr : ' '; exit 0; }
exec $(command -v date) "\$@"
EOF
chmod +x "$CLOCK_BIN/date"
seconds_until_fn="$(sed -n '/^seconds_until()/,/^}/p' "$BACKUP_SH")"
until_at() { env PATH="$CLOCK_BIN:$PATH" FAKE_CLOCK="$1" sh -c "$seconds_until_fn
seconds_until $2"; }
assert_eq "$(until_at 02:59:00 03:00)" "60" "seconds_until 03:00 at 02:59:00 => 60"
assert_eq "$(until_at 03:00:00 03:00)" "86400" "seconds_until 03:00 at 03:00:00 => tomorrow's, 86400"
assert_eq "$(until_at 03:01:00 03:00)" "86340" "seconds_until 03:00 at 03:01:00 => 86340"

# --- loop ----------------------------------------------------------------------------------------
reset
out="$(bk HIVE_BACKUPS=off sh "$BACKUP_SH" loop 2>&1)"; code=$?
assert_contains "$out" "backups off" "HIVE_BACKUPS=off logs it"
assert_eq "$(cat "$FAKE_LOG")" "sleep infinity" "HIVE_BACKUPS=off idles (no exit, no dump)"
reset
at="$(TZ=UTC date -d '+2 min' +%H:%M 2>/dev/null || TZ=UTC date -v+2M +%H:%M)"
out="$(bk HIVE_BACKUP_TIME="$at" sh "$BACKUP_SH" loop 2>&1)"
s="$(sed -n '1s/^sleep //p' "$FAKE_LOG")"
[ "${s:-0}" -gt 60 ] && [ "${s:-0}" -le 120 ] && pass || fail "loop sleeps until HIVE_BACKUP_TIME=$at (slept '$s')"
assert_contains "$(cat "$FAKE_LOG")" "pg_dump -Fc" "loop runs once after the sleep"
assert_eq "$(ls -A "$B" | grep -c '^hive-')" "1" "loop wrote a dump"
reset
out="$(bk HIVE_BACKUP_TIME=25:99 sh "$BACKUP_SH" loop 2>&1)"
assert_contains "$out" "using 03:00" "a bad HIVE_BACKUP_TIME falls back to 03:00"

# --- the copies embedded in the compose files are scripts/backup.sh ------------------------------
for f in docker-compose.yml docker-compose.release.yml; do
  awk '
    /^      HIVE_BACKUP_SH: \|$/ { on = 1; next }
    on && /^$/ { print; next }
    on && /^        / { print substr($0, 9); next }
    on { exit }
  ' "$REPO_ROOT/$f" | sed 's/\$\$/$/g' > "$TMP/embedded.sh"
  if cmp -s "$TMP/embedded.sh" "$BACKUP_SH"; then pass
  else fail "$f: HIVE_BACKUP_SH (\$\$ -> \$) differs from scripts/backup.sh"; diff "$BACKUP_SH" "$TMP/embedded.sh" | head -10 >&2; fi
  assert_contains "$(cat "$REPO_ROOT/$f")" '- ${HIVE_BACKUP_DIR:-hive-backups}:/backups' "$f mounts the backup dir"
  assert_not_contains "$(sed -n '/^  backup:/,/^  [a-z]/p' "$REPO_ROOT/$f")" "extra_hosts" "$f: no extra_hosts on backup"
done

# --- backup-now.sh -------------------------------------------------------------------------------
H="$TMP/install"; mkdir -p "$H"; printf 'HIVE_PROJECT=hb\n' > "$H/.env"
now() { ( cd "$TMP" && env PATH="$FAKE_BIN:$PATH" HOME="$TMP" "$@" < /dev/null ); }
compose_calls() { grep -c '^docker compose ' "$FAKE_LOG"; }

: > "$FAKE_LOG"
out="$(now bash "$BACKUP_NOW" --dir "$H" 2>&1)"; code=$?
assert_eq "$code" "0" "backup-now on a free project succeeds"
assert_contains "$(cat "$FAKE_LOG")" "docker compose --project-directory $H -p hb run --rm --no-deps -T backup once" \
  "backup-now runs once with the install's project"
: > "$FAKE_LOG"
now FAKE_PS_PROJECT=hb FAKE_PS_WORKDIR="$H" HIVE_HOME="$H/" bash "$BACKUP_NOW" --project hb >/dev/null 2>&1; code=$?
assert_eq "$code" "0" "backup-now on its own project (HIVE_HOME, unclean) succeeds"
assert_eq "$(compose_calls)" "1" "backup-now on its own project => one compose call"

: > "$FAKE_LOG"
out="$(now FAKE_PS_PROJECT=hb FAKE_PS_WORKDIR=/somewhere/else bash "$BACKUP_NOW" --dir "$H" 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "backup-now on another dir's project => exits non-zero"
assert_contains "$out" "/somewhere/else" "backup-now on another dir's project => names it"
assert_eq "$(compose_calls)" "0" "backup-now on another dir's project => no compose calls"
: > "$FAKE_LOG"
out="$(now FAKE_PS_FAIL=1 bash "$BACKUP_NOW" --dir "$H" 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "backup-now when docker ps fails => exits non-zero"
assert_contains "$out" "cannot list containers for project hb" "backup-now when docker ps fails => says so"
assert_eq "$(compose_calls)" "0" "backup-now when docker ps fails => no compose calls"
: > "$FAKE_LOG"
out="$(now bash "$BACKUP_NOW" --dir "$TMP/nothing" 2>&1)"; code=$?
assert_eq "$code" "2" "backup-now without a .env exits 2"
assert_eq "$(compose_calls)" "0" "backup-now without a .env => no compose calls"

# no --dir or HIVE_HOME: its own dir when that holds .env, else the repo root (the dir above scripts/)
mkdir -p "$TMP/own" "$TMP/repo/scripts"
cp "$BACKUP_NOW" "$TMP/own/"; cp "$BACKUP_NOW" "$TMP/repo/scripts/"
printf 'HIVE_PROJECT=own\n' > "$TMP/own/.env"; : > "$TMP/repo/.env"
: > "$FAKE_LOG"
now bash "$TMP/own/backup-now.sh" >/dev/null 2>&1
assert_contains "$(cat "$FAKE_LOG")" "--project-directory $TMP/own -p own run" "no --dir => its own dir when it holds .env"
: > "$FAKE_LOG"
now bash "$TMP/repo/scripts/backup-now.sh" >/dev/null 2>&1
assert_contains "$(cat "$FAKE_LOG")" "--project-directory $TMP/repo -p hive run" "no --dir => the repo root, project hive"

# --- restore.sh ----------------------------------------------------------------------------------
RESTORE="$REPO_ROOT/scripts/restore.sh"
printf 'HIVE_PROJECT=hb\nPOSTGRES_PASSWORD=pw-SECRET\n' > "$H/.env"
line_of() { grep -n -m1 -F -- "$1" "$FAKE_LOG" | cut -d: -f1; }

: > "$FAKE_LOG"
out="$(now FAKE_COUNTS_RESTORED=$'anchors 3\nfacts 12\ninstances 2' FAKE_COUNTS_LIVE=$'anchors 3\nfacts 13\ninstances 2' \
  bash "$RESTORE" latest --dir "$H" 2>&1)"; code=$?
assert_eq "$code" "0" "restore.sh latest succeeds"
db="$(sed -n 's/.* backup restore latest \(.*\)$/\1/p' "$FAKE_LOG")"
[[ "$db" =~ ^hive_restore_[0-9]{14}$ ]] && pass || fail "restore.sh defaults to hive_restore_<YYYYMMDDHHMMSS> (got '$db')"
assert_contains "$(cat "$FAKE_LOG")" "docker compose --project-directory $H -p hb run --rm --no-deps -T backup restore latest $db" \
  "restore.sh runs the backup service's restore"
assert_contains "$(cat "$FAKE_LOG")" "-T backup counts $db" "restore.sh counts the restored db"
assert_contains "$(cat "$FAKE_LOG")" "-T backup counts hive" "restore.sh counts the live db"
assert_not_contains "$(cat "$FAKE_LOG")" " stop " "the drill stops nothing"
assert_contains "$out" "facts                                12         13  *" "a row that differs is marked"
assert_contains "$out" "anchors                               3          3"$'\n' "a row that matches is not"
assert_contains "$out" "3 tables, 1 differ (live db keeps changing; informational)" "restore.sh sums up"
assert_contains "$out" "docker compose --project-directory $H -p hb exec -T postgres dropdb -U hive $db" \
  "restore.sh prints the drop command"
assert_not_contains "$out" "pw-SECRET" "restore.sh never prints the password"

: > "$FAKE_LOG"
out="$(now FAKE_COUNTS_RESTORED='facts 1' FAKE_COUNTS_LIVE=$'facts 1\nnewtable 4' \
  bash "$RESTORE" hive-20261118-0300.dump --into drill_1 --dir "$H" 2>&1)"; code=$?
assert_eq "$code" "0" "restore.sh --into a new name succeeds"
assert_contains "$(cat "$FAKE_LOG")" "-T backup restore hive-20261118-0300.dump drill_1" "restore.sh passes the file and --into"
assert_contains "$out" "newtable                              -          4  *" "a table on one side only shows - and is marked"

: > "$FAKE_LOG"
out="$(now FAKE_RESTORE_FAIL=1 bash "$RESTORE" latest --dir "$H" 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "restore.sh: a failed restore => exits non-zero"
assert_not_contains "$(cat "$FAKE_LOG")" "backup counts" "restore.sh: a failed restore => no counts"

: > "$FAKE_LOG"
out="$(now bash "$RESTORE" latest --into hive --dir "$H" 2>&1)"; code=$?
assert_eq "$code" "2" "restore.sh --into hive without --yes exits 2"
assert_contains "$out" "--yes" "restore.sh --into hive without --yes says to add --yes"
assert_eq "$(compose_calls)" "0" "restore.sh --into hive without --yes => no compose calls"

: > "$FAKE_LOG"
out="$(now FAKE_COUNTS_LIVE='facts 12' bash "$RESTORE" latest --into hive --yes --dir "$H" 2>&1)"; code=$?
assert_eq "$code" "0" "restore.sh --into hive --yes succeeds"
s1="$(line_of "-p hb stop hive hive-worker")"; s2="$(line_of "-T backup restore latest hive")"
s3="$(line_of "-p hb up -d --wait hive hive-worker")"
[ -n "$s1" ] && [ -n "$s2" ] && [ -n "$s3" ] && [ "$s1" -lt "$s2" ] && [ "$s2" -lt "$s3" ] && pass \
  || fail "restore.sh --into hive: stop, then restore, then up -d --wait (lines '$s1' '$s2' '$s3')"
assert_eq "$(grep -c ' up -d ' "$FAKE_LOG")" "1" "restore.sh --into hive starts them again once"
assert_contains "$out" "facts                                12" "restore.sh --into hive prints the restored counts"
assert_not_contains "$out" "dropdb" "restore.sh --into hive prints no drop command"

: > "$FAKE_LOG"
out="$(now FAKE_RESTORE_FAIL=1 bash "$RESTORE" latest --into hive --yes --dir "$H" 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "restore.sh --into hive, failed restore => exits non-zero"
assert_contains "$(cat "$FAKE_LOG")" "-p hb up -d --wait hive hive-worker" "restore.sh --into hive, failed restore => starts them again"

for bad_db in Hive 1abc a-b 'x;y'; do
  : > "$FAKE_LOG"
  out="$(now bash "$RESTORE" latest --into "$bad_db" --dir "$H" 2>&1)"; code=$?
  assert_eq "$code" "2" "restore.sh --into '$bad_db' exits 2"
  assert_eq "$(compose_calls)" "0" "restore.sh --into '$bad_db' => no compose calls"
done
: > "$FAKE_LOG"
out="$(now bash "$RESTORE" --dir "$H" 2>&1)"; code=$?
assert_eq "$code" "2" "restore.sh without a file exits 2"

: > "$FAKE_LOG"
out="$(now FAKE_PS_PROJECT=hb FAKE_PS_WORKDIR=/somewhere/else bash "$RESTORE" latest --dir "$H" 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "restore.sh on another dir's project => exits non-zero"
assert_contains "$out" "/somewhere/else" "restore.sh on another dir's project => names it"
assert_eq "$(compose_calls)" "0" "restore.sh on another dir's project => no compose calls"
: > "$FAKE_LOG"
out="$(now FAKE_PS_FAIL=1 bash "$RESTORE" latest --into hive --yes --dir "$H" 2>&1)"; code=$?
[ "$code" -ne 0 ] && pass || fail "restore.sh when docker ps fails => exits non-zero"
assert_contains "$out" "cannot list containers for project hb" "restore.sh when docker ps fails => says so"
assert_eq "$(compose_calls)" "0" "restore.sh when docker ps fails => no compose calls"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
