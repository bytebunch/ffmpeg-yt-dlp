#!/bin/sh
# Database backups (DEPLOY.md §4.10), run by the compose service "backup" (postgres image, so
# pg_dump matches the bundled server).
#   media-backup schedule   one dump a day at BACKUP_HOUR (UTC), until stopped
#   media-backup once       one dump now (restore drills, before an upgrade)
# Settings from .env: DATABASE_URL; BACKUP_ENABLED=false keeps the service idle (an external
# database with its own backups); BACKUP_HOUR (3); BACKUP_RETENTION_DAYS (14); BACKUP_PING_URL
# (e.g. healthchecks.io: pinged after each dump, "<url>/fail" when a dump fails).
set -eu

dir=${BACKUP_DIR:-/backups}
retention=${BACKUP_RETENTION_DAYS:-14}
hour=${BACKUP_HOUR:-3}

ping() {  # [suffix]
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  wget -q -T 10 -O /dev/null "${BACKUP_PING_URL}${1:-}" || echo "backup: could not reach BACKUP_PING_URL" >&2
}

dump() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  partial="$dir/.media-$stamp.dump.partial"
  # Custom format: compressed, and pg_restore can restore selectively.
  if pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$partial"; then
    mv "$partial" "$dir/media-$stamp.dump"
    # -mtime +N matches files older than N+1 days.
    find "$dir" -maxdepth 1 -type f -name 'media-*.dump' -mtime +"$((retention - 1))" -delete
    echo "backup: wrote media-$stamp.dump"
    ping
  else
    rm -f "$partial"
    echo "backup: pg_dump failed" >&2
    ping /fail
    return 1
  fi
}

# Seconds until the next BACKUP_HOUR:00 UTC.
until_next_run() {
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) $(printf '%02d' "$hour"):00:00" +%s)
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  echo $((next - now))
}

# Sleeps in the background, so `docker compose stop` (SIGTERM) ends the wait at once; the
# handler also ends the sleep itself rather than leaving it behind.
sleeper=
pause() {
  sleep "$1" &
  sleeper=$!
  wait "$sleeper" || true
  sleeper=
}
stop() {
  [ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null || true
  exit 0
}
trap stop TERM INT

case "${1:-}" in
  once)
    dump
    ;;
  schedule)
    if [ "${BACKUP_ENABLED:-true}" = false ]; then
      echo "backup: BACKUP_ENABLED=false, idle"
      while :; do pause 86400; done
    fi
    echo "backup: daily at $(printf '%02d' "$hour"):00 UTC into $dir, keeping $retention days"
    while :; do
      pause "$(until_next_run)"
      # A failed dump is reported and retried tomorrow; the service keeps running.
      dump || true
    done
    ;;
  *)
    echo "usage: media-backup once | schedule" >&2
    exit 2
    ;;
esac
