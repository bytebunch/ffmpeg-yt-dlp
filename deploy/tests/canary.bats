#!/usr/bin/env bats
# canary.sh with a stand-in smoke.sh and curl.

setup() {
  MEDIA_DIR=$(mktemp -d)
  STUBS=$(mktemp -d)
  CALLS=$STUBS/calls
  export MEDIA_DIR CALLS
  cat >"$MEDIA_DIR/smoke.sh" <<'STUB'
#!/usr/bin/env bash
echo "smoke BASE_URL=$BASE_URL API_KEY=$API_KEY SMOKE_STRICT=$SMOKE_STRICT" >>"$CALLS"
[ -z "${SMOKE_FAILS:-}" ]
STUB
  cat >"$STUBS/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl ${*: -1}" >>"$CALLS"
STUB
  chmod +x "$MEDIA_DIR/smoke.sh" "$STUBS/curl"
  PATH="$STUBS:$PATH"
  printf '%s\n' 'PUBLIC_BASE_URL=https://dl.example.test' 'CANARY_API_KEY="mk_canary"' \
    'CANARY_PING_URL=https://hc-ping.test/abc' >"$MEDIA_DIR/.env"
}

teardown() {
  rm -rf "$MEDIA_DIR" "$STUBS"
}

@test "runs smoke.sh strictly against PUBLIC_BASE_URL and pings on success" {
  run /deploy/canary.sh
  [ "$status" -eq 0 ]
  grep -qx "smoke BASE_URL=https://dl.example.test API_KEY=mk_canary SMOKE_STRICT=1" "$CALLS"
  grep -qx "curl https://hc-ping.test/abc" "$CALLS"
}

@test "pings <url>/fail and exits non-zero when the smoke test fails" {
  run env SMOKE_FAILS=1 /deploy/canary.sh
  [ "$status" -ne 0 ]
  grep -qx "curl https://hc-ping.test/abc/fail" "$CALLS"
}

@test "CANARY_BASE_URL overrides the address; no ping URL means no ping" {
  printf '%s\n' 'PUBLIC_BASE_URL=https://dl.example.test' 'CANARY_API_KEY=mk_canary' \
    'CANARY_BASE_URL=http://127.0.0.1:8080' >"$MEDIA_DIR/.env"
  /deploy/canary.sh
  grep -qx "smoke BASE_URL=http://127.0.0.1:8080 API_KEY=mk_canary SMOKE_STRICT=1" "$CALLS"
  [ "$(grep -c '^curl' "$CALLS" || true)" -eq 0 ]
}

@test "refuses to run without a key" {
  printf '%s\n' 'PUBLIC_BASE_URL=https://dl.example.test' >"$MEDIA_DIR/.env"
  run /deploy/canary.sh
  [ "$status" -ne 0 ]
  [[ $output == *"CANARY_API_KEY is not set"* ]]
}
