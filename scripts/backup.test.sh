#!/usr/bin/env bash
# Tests for scripts/backup.sh and scripts/backup-now.sh. No Docker or Postgres needed.
#
#   bash scripts/backup.test.sh
#
# backup.sh runs under sh with BACKUPS/BACKUPS_COPY pointed at temp dirs and fakes on PATH: `pg_dump` (logs its argv,
# writes FAKE_DUMP into -f; FAKE_PGDUMP_FAIL=1 writes half a dump and fails), `cp` (logs its argv), `sleep` (logs its argv; the second call
# stops the loop) and `docker` for backup-now.sh (FAKE_PS_FAIL, FAKE_PS_PROJECT + FAKE_PS_WORKDIR, as install.test.sh).
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
cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  ps)
    [ "${FAKE_PS_FAIL:-}" = 1 ] && { echo "permission denied while trying to connect to the Docker daemon" >&2; exit 1; }
    case "$*" in *"label=com.docker.compose.project=${FAKE_PS_PROJECT:-none} "*) echo "${FAKE_PS_WORKDIR:-}" ;; esac
    exit 0 ;;
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

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
