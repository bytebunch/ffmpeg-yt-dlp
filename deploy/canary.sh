#!/usr/bin/env bash
# Daily server canary (DEPLOY.md §4.10): smoke.sh in strict mode against this install, so a real
# download, a recipe and a transcription must work, then a healthchecks.io-style ping.
#   crontab -e:  15 5 * * * /srv/media/canary.sh >>/srv/media/canary.log 2>&1
# Settings in /srv/media/.env (or the environment):
#   CANARY_API_KEY    a key for the canary (cli keys:create canary --default-user canary --quiet)
#   CANARY_PING_URL   pinged after a good run, "<url>/fail" after a bad one (optional)
#   CANARY_BASE_URL   where to test; default PUBLIC_BASE_URL
set -euo pipefail

dir=${MEDIA_DIR:-$(cd "$(dirname "$0")" && pwd)}

die() { echo "canary: $*" >&2; exit 1; }
# The last assignment of KEY in .env, without quotes.
env_value() {
  if [ -f "$dir/.env" ]; then sed -n "s/^$1=//p" "$dir/.env" | tail -1 | tr -d "\"'"; fi
}

key=${CANARY_API_KEY:-$(env_value CANARY_API_KEY)}
base=${CANARY_BASE_URL:-$(env_value CANARY_BASE_URL)}
base=${base:-$(env_value PUBLIC_BASE_URL)}
ping_url=${CANARY_PING_URL:-$(env_value CANARY_PING_URL)}
[ -n "$key" ] || die "CANARY_API_KEY is not set (see the header of this script)"
[ -n "$base" ] || die "neither CANARY_BASE_URL nor PUBLIC_BASE_URL is set"

ping() {  # [suffix]
  [ -n "$ping_url" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "$ping_url${1:-}" || echo "canary: could not reach CANARY_PING_URL" >&2
}

echo "canary: $(date -u +%FT%TZ) against $base"
if BASE_URL=$base API_KEY=$key SMOKE_STRICT=1 "$dir/smoke.sh"; then
  ping
  echo "canary: passed"
else
  ping /fail
  die "failed"
fi
