#!/usr/bin/env bash
# Post-deploy smoke test (DEPLOY.md §6), run by install.sh with a temporary API key:
#   BASE_URL=http://127.0.0.1:8085 API_KEY=mk_... ./smoke.sh
# Infrastructure checks must pass. The real-site lookup only warns unless SMOKE_STRICT=1,
# because a site blocking the server's IP is not a reason to roll back a release.
set -euo pipefail

base=${BASE_URL:?BASE_URL is required}
key=${API_KEY:?API_KEY is required}
info_url=${SMOKE_INFO_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}
failures=0

pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf 'warn  %s\n' "$1"; }

status() {  # <method> <path> [curl args...]: prints the HTTP status
  local method=$1 path=$2
  shift 2
  curl -s -o /tmp/smoke-body.$$ -w '%{http_code}' -X "$method" --max-time 120 "$@" "$base$path" || echo 000
}
body() { cat /tmp/smoke-body.$$; }
trap 'rm -f /tmp/smoke-body.$$' EXIT

expect() {  # <description> <expected status> <method> <path> [curl args...]
  local description=$1 expected=$2 code
  shift 2
  code=$(status "$@")
  if [[ $code == "$expected" ]]; then pass "$description"; else fail "$description ($code): $(body)"; fi
}

expect "health" 200 GET /health
expect "OpenAPI document" 200 GET /docs/json
expect "API key required" 401 GET /v1/presets
auth=(-H "Authorization: Bearer $key")
if [[ $(status GET /v1/presets "${auth[@]}") == 200 ]] && body | grep -q '"download_presets"'; then
  pass "presets with the key"
else
  fail "presets with the key: $(body)"
fi

code=$(status POST /v1/info "${auth[@]}" -H 'content-type: application/json' -d "{\"url\":\"$info_url\"}")
if [[ $code == 200 ]] && body | grep -q '"title"'; then
  pass "media info for $info_url"
elif [[ ${SMOKE_STRICT:-0} == 1 ]]; then
  fail "media info ($code): $(body)"
else
  warn "media info ($code): $(body | head -c 300)"
fi

# A short download whose signed link nginx must serve with Range support (needs python3 for JSON).
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }
media_output=""
wait_job() {  # <job id>: polls until the job ends, leaves the job in body, prints its status
  local state=queued
  for _ in $(seq 1 90); do
    status GET "/v1/jobs/$1" "${auth[@]}" -H 'x-user-id: smoke' >/dev/null
    state=$(body | json "d['status']")
    [[ $state == completed || $state == failed || $state == cancelled ]] && break
    sleep 2
  done
  echo "$state"
}
download_check() {
  local id state link code
  status POST /v1/jobs "${auth[@]}" -H 'x-user-id: smoke' -H 'content-type: application/json' \
    -d "{\"type\":\"download\",\"url\":\"$info_url\",\"preset\":\"360p\"}" >/dev/null
  id=$(body | json "d['id']") || {
    echo "job not created: $(body | head -c 300)"
    return 1
  }
  state=$(wait_job "$id")
  [[ $state == completed ]] || { echo "job $id ended $state: $(body | head -c 300)"; return 1; }
  media_output=$(body | json "[o['id'] for o in d['outputs'] if o['role'] in ('media','audio')][0]")
  link=$(body | json "[o['url'] for o in d['outputs'] if o['role'] in ('media','audio')][0]")
  link=${link#*://*/}
  code=$(curl -s -o /tmp/smoke-range.$$ -w '%{http_code}' -H 'Range: bytes=0-15' "$base/$link")
  if [[ $code == 206 ]] && grep -q ftyp /tmp/smoke-range.$$; then rm -f /tmp/smoke-range.$$; return 0; fi
  echo "range request answered $code"
  rm -f /tmp/smoke-range.$$
  return 1
}
if ! command -v python3 >/dev/null; then
  warn "download check skipped: python3 is not installed"
elif download_check; then
  pass "download + signed link through nginx (Range → 206)"
elif [[ ${SMOKE_STRICT:-0} == 1 ]]; then
  fail "download + signed link"
else
  warn "download + signed link (real-site download failed; see above)"
fi

# A recipe on worker-ff, on the file just downloaded: no external site involved, so it must pass.
recipe_check() {
  local id state
  status POST /v1/jobs "${auth[@]}" -H 'x-user-id: smoke' -H 'content-type: application/json' \
    -d "{\"type\":\"process\",\"inputs\":[{\"type\":\"output\",\"outputId\":\"$media_output\"}],\"recipe\":{\"steps\":[{\"op\":\"thumbnail\",\"name\":\"smoke\",\"width\":160}]}}" >/dev/null
  id=$(body | json "d['id']") || {
    echo "recipe job not created: $(body | head -c 300)"
    return 1
  }
  state=$(wait_job "$id")
  [[ $state == completed ]] && [[ $(body | json "d['outputs'][0]['mime']") == image/jpeg ]] && return 0
  echo "recipe job $id ended $state: $(body | head -c 300)"
  return 1
}
if [[ -z $media_output ]]; then
  warn "recipe check skipped: no downloaded file to work on"
elif recipe_check; then
  pass "recipe on worker-ff (thumbnail of the download)"
else
  fail "recipe on worker-ff"
fi

if (( failures > 0 )); then
  echo "$failures smoke check(s) failed"
  exit 1
fi
echo "smoke test passed"
