#!/usr/bin/env bats
# backup.sh with stand-ins for pg_dump and wget (the real dump and restore run in scripts/e2e.sh).

setup() {
  BACKUP_DIR=$(mktemp -d)
  STUBS=$(mktemp -d)
  CALLS=$STUBS/calls
  export BACKUP_DIR CALLS DATABASE_URL=postgres://u:p@db:5432/media
  cat >"$STUBS/pg_dump" <<'STUB'
#!/bin/sh
echo "pg_dump $*" >>"$CALLS"
[ -z "${PG_DUMP_FAILS:-}" ] || exit 1
for arg in "$@"; do case $arg in --file=*) printf 'PGDMP' >"${arg#--file=}" ;; esac; done
STUB
  cat >"$STUBS/wget" <<'STUB'
#!/bin/sh
echo "wget $*" >>"$CALLS"
STUB
  chmod +x "$STUBS/pg_dump" "$STUBS/wget"
  PATH="$STUBS:$PATH"
}

teardown() {
  rm -rf "$BACKUP_DIR" "$STUBS"
}

@test "once writes a custom-format dump and renames it only when complete" {
  run /deploy/backup.sh once
  [ "$status" -eq 0 ]
  dump=$(find "$BACKUP_DIR" -name 'media-*.dump')
  [ -s "$dump" ]
  grep -q -- "--format=custom --no-owner --no-privileges --dbname=postgres://u:p@db:5432/media" "$CALLS"
  [ -z "$(find "$BACKUP_DIR" -name '*.partial')" ]
}

@test "keeps BACKUP_RETENTION_DAYS of dumps and nothing else is touched" {
  touch -d '20 days ago' "$BACKUP_DIR/media-20261010-030000.dump"
  touch -d '13 days ago' "$BACKUP_DIR/media-20261018-030000.dump"
  touch -d '20 days ago' "$BACKUP_DIR/notes.txt"
  /deploy/backup.sh once
  [ ! -e "$BACKUP_DIR/media-20261010-030000.dump" ]
  [ -e "$BACKUP_DIR/media-20261018-030000.dump" ]
  [ -e "$BACKUP_DIR/notes.txt" ]
  BACKUP_RETENTION_DAYS=7 /deploy/backup.sh once
  [ ! -e "$BACKUP_DIR/media-20261018-030000.dump" ]
}

@test "pings BACKUP_PING_URL after a dump, and <url>/fail when pg_dump fails" {
  BACKUP_PING_URL=https://hc-ping.test/abc /deploy/backup.sh once
  grep -q "wget -q -T 10 -O /dev/null https://hc-ping.test/abc$" "$CALLS"
  run env PG_DUMP_FAILS=1 BACKUP_PING_URL=https://hc-ping.test/abc /deploy/backup.sh once
  [ "$status" -ne 0 ]
  [[ $output == *"pg_dump failed"* ]]
  grep -q "https://hc-ping.test/abc/fail$" "$CALLS"
  [ -z "$(find "$BACKUP_DIR" -name '*.partial')" ]
}

@test "schedule stays idle with BACKUP_ENABLED=false and stops on SIGTERM" {
  BACKUP_ENABLED=false /deploy/backup.sh schedule >"$BACKUP_DIR/out" 2>&1 3>&- &
  pid=$!
  sleep 0.5
  kill -TERM "$pid"
  wait "$pid"
  grep -q "BACKUP_ENABLED=false, idle" "$BACKUP_DIR/out"
  # Its sleep went with it.
  run pgrep -f "sleep 86400"
  [ "$status" -ne 0 ]
  [ ! -e "$CALLS" ]
}

@test "schedule waits for BACKUP_HOUR and stops on SIGTERM without dumping" {
  BACKUP_HOUR=$(( ($(date -u +%H | sed 's/^0//') + 2) % 24 )) /deploy/backup.sh schedule >"$BACKUP_DIR/out" 2>&1 3>&- &
  pid=$!
  sleep 0.5
  kill -TERM "$pid"
  wait "$pid"
  grep -q "daily at" "$BACKUP_DIR/out"
  [ ! -e "$CALLS" ]
}

@test "refuses unknown commands" {
  run /deploy/backup.sh nightly
  [ "$status" -eq 2 ]
}
