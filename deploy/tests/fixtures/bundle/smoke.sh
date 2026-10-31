#!/usr/bin/env bash
# Test double for the bundle's smoke.sh.
set -euo pipefail
printf 'smoke.sh BASE_URL=%s API_KEY=%s\n' "$BASE_URL" "${API_KEY:+set}" >>"$CALLS_LOG"
exit "${STUB_SMOKE_EXIT:-0}"
