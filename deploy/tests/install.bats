#!/usr/bin/env bats
# Tests for deploy/install.sh and deploy/deploy.sh. Run them with tests/run.sh: they expect an
# Ubuntu 24.04 container running as root. Commands that change the server (docker, systemctl,
# apt-get, iptables) are replaced by the recording stand-ins in tests/stubs.
#
# shellcheck disable=SC2016,SC2034,SC2317
# SC2034: variables set here are read by the sourced install.sh functions. SC2016: the single-quoted scripts are expanded by the inner shell.
# SC2317: function overrides are called by install.sh, not by the test itself.

setup() {
  INSTALL_SH="$BATS_TEST_DIRNAME/../install.sh"
  export CALLS_LOG="$BATS_TEST_TMPDIR/calls.log"
  export FIXTURE_BUNDLE="$BATS_TEST_DIRNAME/fixtures/bundle"
  export PATH="$BATS_TEST_DIRNAME/stubs:$PATH"
  export STUB_REVISION=1111111111111111111111111111111111111111
  MEDIA="$BATS_TEST_TMPDIR/media"
  : >"$CALLS_LOG"
  rm -f /var/log/media-install.log /etc/docker/daemon.json
  # shellcheck source=/dev/null
  MEDIA_INSTALL_SOURCED=1 source "$INSTALL_SH"
}

# Runs install.sh's main the way the guard at the end of the script does, with extra
# environment assignments as arguments. STUB_AVX2 (yes|no) replaces the CPU's AVX2 check.
run_installer() {
  run env "$@" bash -c '
    MEDIA_INSTALL_SOURCED=1 source "$1"
    cpu_has_avx2() { echo "${STUB_AVX2:-yes}"; }
    set -Eeuo pipefail
    main' _ "$INSTALL_SH"
}

first_install() {
  run_installer MEDIA_DIR="$MEDIA" MEDIA_IMAGE=ghcr.io/acme/media-service "$@"
  [ "$status" -eq 0 ]
}

# A first install whose image pull fails with that line from Docker; the output must carry it.
pull_fails_with() {  # <docker's error line> [extra environment assignments]
  local error=$1
  shift
  run_installer MEDIA_DIR="$MEDIA" MEDIA_IMAGE=ghcr.io/acme/media-service MEDIA_VERSION=9f25493 \
    STUB_PULL_ERROR="$error" "$@"
  [ "$status" -eq 1 ]
  [[ $output == *"ERROR: Could not pull ghcr.io/acme/media-service:9f25493: $error"* ]]
  [ ! -e "$MEDIA/.env" ]
}

call_line() {  # <pattern>: line number of the first recorded call matching pattern
  grep -n -- "$1" "$CALLS_LOG" | head -n 1 | cut -d: -f1
}

# --- .env editing -------------------------------------------------------------------------------

@test "set_env_var replaces an existing key and keeps the other lines in order" {
  printf '# comment\nA=1\nB=2\nC=3\n' >"$BATS_TEST_TMPDIR/env"
  set_env_var "$BATS_TEST_TMPDIR/env" B new
  [ "$(cat "$BATS_TEST_TMPDIR/env")" = $'# comment\nA=1\nB=new\nC=3' ]
}

@test "set_env_var appends a missing key, also when the file has no final newline" {
  printf 'A=1' >"$BATS_TEST_TMPDIR/env"
  set_env_var "$BATS_TEST_TMPDIR/env" B 2
  [ "$(cat "$BATS_TEST_TMPDIR/env")" = $'A=1\nB=2' ]
}

@test "set_env_var stores values with shell and sed metacharacters verbatim" {
  printf 'A=1\n' >"$BATS_TEST_TMPDIR/env"
  value=$'a/b+c=d&e\\f \'x\' "y" $HOME `id`'
  json=$'\'{"fast":"/models/ggml-base-q8_0.bin"}\''
  set_env_var "$BATS_TEST_TMPDIR/env" SECRET "$value"
  set_env_var "$BATS_TEST_TMPDIR/env" MODELS "$json"
  [ "$(get_env_var "$BATS_TEST_TMPDIR/env" SECRET)" = "$value" ]
  [ "$(get_env_var "$BATS_TEST_TMPDIR/env" MODELS)" = "$json" ]
}

@test "set_env_var keeps only the first of duplicate assignments" {
  printf 'A=1\nB=2\nA=3\n' >"$BATS_TEST_TMPDIR/env"
  set_env_var "$BATS_TEST_TMPDIR/env" A 9
  [ "$(cat "$BATS_TEST_TMPDIR/env")" = $'A=9\nB=2' ]
}

@test "set_env_var leaves the file readable by root only" {
  printf 'A=1\n' >"$BATS_TEST_TMPDIR/env"
  chmod 644 "$BATS_TEST_TMPDIR/env"
  set_env_var "$BATS_TEST_TMPDIR/env" A 2
  [ "$(stat -c %a "$BATS_TEST_TMPDIR/env")" = 600 ]
}

@test "get_env_var returns values containing '=' and fails for a missing key" {
  printf 'KEY=abc==\nAB=1\n' >"$BATS_TEST_TMPDIR/env"
  [ "$(get_env_var "$BATS_TEST_TMPDIR/env" KEY)" = "abc==" ]
  run get_env_var "$BATS_TEST_TMPDIR/env" A
  [ "$status" -eq 1 ]
}

# --- checks -------------------------------------------------------------------------------------

@test "check_os accepts Ubuntu 24.04+ and Debian 13+ on amd64" {
  check_os ubuntu 24.04 amd64
  check_os ubuntu 26.04 amd64
  check_os debian 13 amd64
}

@test "check_os rejects older releases, other distributions and other architectures" {
  run check_os ubuntu 22.04 amd64
  [ "$status" -eq 1 ] && [[ $output == *"Ubuntu 22.04 is not supported"* ]]
  run check_os debian 12 amd64
  [ "$status" -eq 1 ] && [[ $output == *"Debian 12 is not supported"* ]]
  run check_os fedora 41 amd64
  [ "$status" -eq 1 ] && [[ $output == *"'fedora' is not supported"* ]]
  run check_os ubuntu 24.04 arm64
  [ "$status" -eq 1 ] && [[ $output == *"architecture 'arm64'"* ]]
}

@test "is_port and is_ipv4 accept valid values and reject the rest" {
  is_port 1 && is_port 8080 && is_port 65535
  run is_port 0;      [ "$status" -eq 1 ]
  run is_port 65536;  [ "$status" -eq 1 ]
  run is_port 80a;    [ "$status" -eq 1 ]
  is_ipv4 0.0.0.0 && is_ipv4 127.0.0.1 && is_ipv4 255.255.255.255
  run is_ipv4 256.0.0.1;  [ "$status" -eq 1 ]
  run is_ipv4 1.2.3;      [ "$status" -eq 1 ]
  run is_ipv4 localhost;  [ "$status" -eq 1 ]
}

@test "validate_settings accepts the defaults" {
  MEDIA_IMAGE=ghcr.io/acme/media-service MEDIA_VERSION=main MEDIA_DIR=/srv/media
  MEDIA_FILES_PATH=/srv/media/files HTTP_PORT=8085 HTTP_BIND=127.0.0.1 MODELS=all PUBLIC_BASE_URL=
  validate_settings
  PUBLIC_BASE_URL=https://dl.example.com:8443
  validate_settings
}

@test "validate_settings rejects each invalid setting with a message naming it" {
  valid() {
    MEDIA_IMAGE=ghcr.io/acme/media-service MEDIA_VERSION=main MEDIA_DIR=/srv/media
    MEDIA_FILES_PATH=/srv/media/files HTTP_PORT=8085 HTTP_BIND=127.0.0.1 MODELS=all PUBLIC_BASE_URL=
  }
  for case in \
    "MEDIA_IMAGE=Not/An:Image!|MEDIA_IMAGE" \
    "MEDIA_VERSION=../x|MEDIA_VERSION" \
    "MEDIA_DIR=relative/path|MEDIA_DIR" \
    "MEDIA_DIR=/srv/../etc|MEDIA_DIR" \
    "MEDIA_FILES_PATH=/mnt/my files|MEDIA_FILES_PATH" \
    "HTTP_PORT=99999|HTTP_PORT" \
    "HTTP_BIND=localhost|HTTP_BIND" \
    "MODELS=large|MODELS" \
    "PUBLIC_BASE_URL=https://dl.example.com/api|PUBLIC_BASE_URL"; do
    valid
    assignment=${case%%|*}
    printf -v "${assignment%%=*}" '%s' "${assignment#*=}"
    run validate_settings
    [ "$status" -eq 1 ]
    [[ $output == *"${case#*|}"* ]]
  done
}

# --- settings and configuration -----------------------------------------------------------------

@test "default_public_url uses the server IP, drops port 80 and honours a specific bind address" {
  [ "$(default_public_url 0.0.0.0 203.0.113.10 8080)" = http://203.0.113.10:8080 ]
  [ "$(default_public_url 0.0.0.0 203.0.113.10 80)" = http://203.0.113.10 ]
  [ "$(default_public_url 127.0.0.1 203.0.113.10 8080)" = http://127.0.0.1:8080 ]
  [ "$(default_public_url 127.0.0.1 "" 8085)" = http://127.0.0.1:8085 ]
}

@test "model_names maps each MODELS choice to model names" {
  [ "$(model_names all)" = "fast balanced accurate" ]
  [ "$(model_names fast)" = fast ]
  [ -z "$(model_names none)" ]
}

@test "record_release appends new releases and skips a repeat of the last one" {
  history="$BATS_TEST_TMPDIR/history"
  record_release "$history" aaa
  record_release "$history" aaa
  record_release "$history" bbb
  [ "$(cat "$history")" = $'aaa\nbbb' ]
}

@test "install_bundle installs files with the right modes and never ships .env or an override file" {
  src="$BATS_TEST_TMPDIR/src" dest="$BATS_TEST_TMPDIR/dest"
  cp -R "$FIXTURE_BUNDLE" "$src"
  echo "SHIPPED=1" >"$src/.env"
  echo "shipped" >"$src/docker-compose.override.yml"
  mkdir -p "$dest"
  echo "LOCAL=1" >"$dest/.env"
  install_bundle "$src" "$dest"
  [ "$(stat -c %a "$dest/smoke.sh")" = 755 ]
  [ "$(stat -c %a "$dest/host/egress-firewall.sh")" = 755 ]
  [ "$(stat -c %a "$dest/docker-compose.yml")" = 644 ]
  [ "$(cat "$dest/.env")" = "LOCAL=1" ]
  [ ! -e "$dest/docker-compose.override.yml" ]
  [ -z "$(find "$dest" -name '*.new')" ]
}

@test "install_bundle replaces files by rename, so a running script keeps its old inode" {
  src="$BATS_TEST_TMPDIR/src" dest="$BATS_TEST_TMPDIR/dest"
  cp -R "$FIXTURE_BUNDLE" "$src"
  install_bundle "$src" "$dest"
  before=$(stat -c %i "$dest/smoke.sh")
  install_bundle "$src" "$dest"
  [ "$(stat -c %i "$dest/smoke.sh")" != "$before" ]
}

@test "install_bundle refuses an image without a bundle" {
  mkdir -p "$BATS_TEST_TMPDIR/empty"
  run install_bundle "$BATS_TEST_TMPDIR/empty" "$BATS_TEST_TMPDIR/dest"
  [ "$status" -eq 1 ] && [[ $output == *"no deployment bundle"* ]]
}

@test "write_initial_env generates distinct secrets and one consistent database password" {
  MEDIA_DIR="$MEDIA" ENV_FILE="$MEDIA/.env" MODELS=fast HTTP_PORT=8080 HTTP_BIND=0.0.0.0
  MEDIA_FILES_PATH=/mnt/media-files PUBLIC_BASE_URL=
  install_bundle "$FIXTURE_BUNDLE" "$MEDIA"
  write_initial_env
  [ "$(stat -c %a "$ENV_FILE")" = 600 ]
  pg=$(get_env_var "$ENV_FILE" POSTGRES_PASSWORD)
  [[ $pg =~ ^[0-9a-f]{48}$ ]]
  [ "$(get_env_var "$ENV_FILE" DATABASE_URL)" = "postgres://ytdlp_app:$pg@postgres:5432/media" ]
  link=$(get_env_var "$ENV_FILE" LINK_SIGNING_SECRET)
  keys=$(get_env_var "$ENV_FILE" TOKEN_ENCRYPTION_KEYS)
  [ "$(printf '%s' "$link" | base64 -d | wc -c)" -eq 32 ]
  [[ $keys == v1:* ]] && [ "${keys#v1:}" != "$link" ]
  [ "$(get_env_var "$ENV_FILE" PUBLIC_BASE_URL)" = http://203.0.113.10:8080 ]
  [ "$(get_env_var "$ENV_FILE" MEDIA_FILES_PATH)" = /mnt/media-files ]
  [ "$(get_env_var "$ENV_FILE" COMPOSE_PROFILES)" = local-db,local-redis,proxy ]
  [ "$(get_env_var "$ENV_FILE" FFMPEG_WHISPER_DEFAULT_MODEL)" = fast ]
  [ "$(get_env_var "$ENV_FILE" LOG_LEVEL)" = info ]
}

@test "write_initial_env defaults to this server only, without looking up the server's address" {
  MEDIA_DIR="$MEDIA" ENV_FILE="$MEDIA/.env" MODELS=none HTTP_PORT=8085 HTTP_BIND=127.0.0.1
  MEDIA_FILES_PATH=/srv/media/files PUBLIC_BASE_URL=
  install_bundle "$FIXTURE_BUNDLE" "$MEDIA"
  STUB_IP=10.1.2.3 write_initial_env 2>"$BATS_TEST_TMPDIR/err"
  [ "$(get_env_var "$ENV_FILE" PUBLIC_BASE_URL)" = http://127.0.0.1:8085 ]
  [ "$(get_env_var "$ENV_FILE" HTTP_BIND)" = 127.0.0.1 ]
  [ "$(get_env_var "$ENV_FILE" HTTP_PORT)" = 8085 ]
  run grep -c "private" "$BATS_TEST_TMPDIR/err"
  [ "$output" = 0 ]
}

@test "write_initial_env warns when the detected address is private" {
  MEDIA_DIR="$MEDIA" ENV_FILE="$MEDIA/.env" MODELS=none HTTP_PORT=8080 HTTP_BIND=0.0.0.0
  MEDIA_FILES_PATH=/srv/media/files PUBLIC_BASE_URL=
  install_bundle "$FIXTURE_BUNDLE" "$MEDIA"
  STUB_IP=10.1.2.3 write_initial_env 2>"$BATS_TEST_TMPDIR/err"
  grep -q "10.1.2.3 is private" "$BATS_TEST_TMPDIR/err"
}

# --- ports --------------------------------------------------------------------------------------

# ss output from a real server: another stack's container holds 127.0.0.1:3000, and Tailscale
# listens on port 3000 of its own addresses.
AI_SERVER_LISTENERS='LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("docker-proxy",pid=791142,fd=7))
LISTEN 0 4096 100.69.74.125%tailscale0:3000 0.0.0.0:* users:(("tailscaled",pid=571929,fd=26))
LISTEN 0 4096 [fd7a:115c:a1e0::782c:4a7e]%tailscale0:3000 [::]:* users:(("tailscaled",pid=571929,fd=22))'

@test "port_conflicts follows the kernel's bind rules for an IPv4 address" {
  port_conflicts 127.0.0.1 127.0.0.1
  port_conflicts 127.0.0.1 0.0.0.0
  port_conflicts 127.0.0.1 '*'
  port_conflicts 0.0.0.0 0.0.0.0
  port_conflicts 0.0.0.0 100.69.74.125
  run port_conflicts 127.0.0.1 100.69.74.125;               [ "$status" -eq 1 ]
  run port_conflicts 127.0.0.1 '[::]';                      [ "$status" -eq 1 ]
  run port_conflicts 0.0.0.0 '[fd7a:115c:a1e0::782c:4a7e]'; [ "$status" -eq 1 ]
}

@test "port_users names the container or program behind a colliding listener and ignores the rest" {
  export STUB_LISTENERS=$AI_SERVER_LISTENERS STUB_PUBLISHERS=3000=ai-server-webui-1
  [ "$(port_users 127.0.0.1 3000)" = "container ai-server-webui-1" ]
  [ "$(port_users 0.0.0.0 3000)" = "container ai-server-webui-1, tailscaled" ]
  [ -z "$(port_users 127.0.0.2 3000)" ]
  [ -z "$(port_users 127.0.0.1 3001)" ]
  export STUB_LISTENERS='LISTEN 0 128 *:8085 *:*'
  [ "$(port_users 127.0.0.1 8085)" = "another program" ]
}

# --- whole install (main) -----------------------------------------------------------------------

@test "first install: configures the server, starts the stack after the firewall and creates the first key" {
  first_install
  env_file="$MEDIA/.env"
  [ "$(get_env_var "$env_file" IMAGE_TAG)" = "$STUB_REVISION" ]
  [ "$(get_env_var "$env_file" MEDIA_IMAGE)" = ghcr.io/acme/media-service ]
  [ "$(get_env_var "$env_file" PUBLIC_BASE_URL)" = http://127.0.0.1:8085 ]
  [ "$(get_env_var "$env_file" HTTP_BIND)" = 127.0.0.1 ]
  [ "$(get_env_var "$env_file" HTTP_PORT)" = 8085 ]
  [[ $output == *"Media Service $STUB_REVISION is running"* ]]
  [[ $output == *"API key  mk_test_default_"* ]]
  [[ $output == *"Access   this server only (HTTP_BIND=127.0.0.1)"* ]]
  [[ $output == *"set HTTP_BIND=0.0.0.0 and PUBLIC_BASE_URL"* ]]
  [[ $output == *"nginx/front.conf"* ]]
  [[ $output != *"Warning  plain HTTP"* ]]
  [ "$(cat "$MEDIA/.release-history")" = "$STUB_REVISION" ]
  [ -f /etc/docker/daemon.json ]
  [ -x /usr/local/sbin/media-egress-firewall ]
  [ "$(stat -c %u "$MEDIA/files")" = 10001 ]
  (( $(call_line "systemctl restart media-egress-firewall.service") < $(call_line "docker compose up") ))
  (( $(call_line "models.sh sync") < $(call_line "docker compose up") ))
  grep -q "docker tag ghcr.io/acme/media-service:main ghcr.io/acme/media-service:$STUB_REVISION" "$CALLS_LOG"
  grep -q "smoke.sh BASE_URL=http://127.0.0.1:8085 API_KEY=set" "$CALLS_LOG"
  grep -q "keys:revoke --key mk_test_installer-smoke_" "$CALLS_LOG"
  grep -q "systemctl restart docker" "$CALLS_LOG"
}

@test "first install: the API key reaches the terminal but never the log file" {
  first_install
  [[ $output == *"mk_test_default_"* ]]
  run grep -c "mk_test_default_" /var/log/media-install.log
  [ "$output" = 0 ]
}

@test "first install with HTTP_BIND=0.0.0.0 opens the port, uses the server address and warns about plain HTTP" {
  first_install HTTP_BIND=0.0.0.0
  [ "$(get_env_var "$MEDIA/.env" PUBLIC_BASE_URL)" = http://203.0.113.10:8085 ]
  [[ $output == *"Warning  plain HTTP on 0.0.0.0"* ]]
  [[ $output != *"this server only"* ]]
  grep -q "smoke.sh BASE_URL=http://127.0.0.1:8085 API_KEY=set" "$CALLS_LOG"
}

@test "behind the developer's own nginx the summary neither says local-only nor warns" {
  first_install
  set_env_var "$MEDIA/.env" PUBLIC_BASE_URL https://dl.example.com
  run_installer MEDIA_DIR="$MEDIA"
  [ "$status" -eq 0 ]
  [[ $output == *"API      https://dl.example.com/v1"* ]]
  [[ $output != *"this server only"* ]]
  [[ $output != *"Warning  plain HTTP"* ]]
}

@test "update: keeps secrets and settings, moves to the new release and creates no new key" {
  first_install
  secret=$(get_env_var "$MEDIA/.env" LINK_SIGNING_SECRET)
  pg=$(get_env_var "$MEDIA/.env" POSTGRES_PASSWORD)
  : >"$CALLS_LOG"
  run_installer MEDIA_DIR="$MEDIA" STUB_REVISION=2222222222222222222222222222222222222222 HTTP_PORT=9090
  [ "$status" -eq 0 ]
  [ "$(get_env_var "$MEDIA/.env" IMAGE_TAG)" = 2222222222222222222222222222222222222222 ]
  [ "$(get_env_var "$MEDIA/.env" LINK_SIGNING_SECRET)" = "$secret" ]
  [ "$(get_env_var "$MEDIA/.env" POSTGRES_PASSWORD)" = "$pg" ]
  [ "$(get_env_var "$MEDIA/.env" HTTP_PORT)" = 8085 ]
  [[ $output == *"HTTP_PORT is only used on the first install"* ]]
  [[ $output != *"API key"* ]]
  grep -q "docker pull ghcr.io/acme/media-service:main" "$CALLS_LOG"
  run grep -c "models.sh env" "$CALLS_LOG"
  [ "$output" = 0 ]
  [ "$(cat "$MEDIA/.release-history")" = $'1111111111111111111111111111111111111111\n2222222222222222222222222222222222222222' ]
}

@test "a failed smoke test stops the update, revokes its key and names the release to roll back to" {
  first_install
  run_installer MEDIA_DIR="$MEDIA" STUB_REVISION=2222222222222222222222222222222222222222 STUB_SMOKE_EXIT=1
  [ "$status" -eq 1 ]
  [[ $output == *"smoke test failed"*"sudo ./deploy.sh $STUB_REVISION"* ]]
  [ "$(grep -c "keys:revoke --key mk_test_installer-smoke_" "$CALLS_LOG")" -eq 2 ]
  [ "$(cat "$MEDIA/.release-history")" = "$STUB_REVISION" ]
}

@test "a first install that failed is finished by the next run, which then creates the key" {
  run_installer MEDIA_DIR="$MEDIA" MEDIA_IMAGE=ghcr.io/acme/media-service STUB_SMOKE_EXIT=1
  [ "$status" -eq 1 ]
  [[ $output != *"API key"* ]]
  run_installer MEDIA_DIR="$MEDIA"
  [ "$status" -eq 0 ]
  [[ $output == *"API key  mk_test_default_"* ]]
}

@test "invalid settings stop the install before anything on the server changes" {
  run_installer MEDIA_DIR="$MEDIA" MEDIA_IMAGE=ghcr.io/acme/media-service HTTP_PORT=abc
  [ "$status" -eq 1 ]
  [[ $output == *"HTTP_PORT must be a port number"* ]]
  [ ! -s "$CALLS_LOG" ]
  [ ! -e "$MEDIA" ]
}

@test "without MEDIA_IMAGE the project's own image is installed" {
  run_installer MEDIA_DIR="$MEDIA"
  [ "$status" -eq 0 ]
  grep -q "docker pull ghcr.io/bytebunch/media-service:main" "$CALLS_LOG"
  [ "$(get_env_var "$MEDIA/.env" MEDIA_IMAGE)" = ghcr.io/bytebunch/media-service ]
}

@test "without AVX2 the install continues with transcription off" {
  first_install STUB_AVX2=no
  [[ $output == *"no AVX2, so transcription is turned off"* ]]
  grep -qx "models.sh env" "$CALLS_LOG"
  [ -z "$(get_env_var "$MEDIA/.env" FFMPEG_WHISPER_DEFAULT_MODEL)" ]
}

@test "GH_TOKEN logs in to the registry without the token reaching arguments or the log" {
  token=ghp_testtoken1234567890
  first_install GH_TOKEN="$token"
  grep -q "docker login ghcr.io --username octo-user --password-stdin" "$CALLS_LOG"
  grep -q "docker login received ${#token} bytes on stdin" "$CALLS_LOG"
  run grep -l "$token" "$CALLS_LOG" /var/log/media-install.log
  [ "$status" -eq 1 ] && [ -z "$output" ]
}

# --- a failed pull -------------------------------------------------------------------------------
# Command output goes to the log only, so the error must carry Docker's reason to the terminal.

@test "a tag that doesn't exist is named, and the full git sha asked for" {
  pull_fails_with 'Error response from daemon: failed to resolve reference "ghcr.io/acme/media-service:9f25493": ghcr.io/acme/media-service:9f25493: not found'
  [[ $output == *"No image is tagged 9f25493"* ]]
  [[ $output == *"full 40-character git sha"* ]]
  [[ $output != *GH_TOKEN* ]]
}

@test "a refused pull without GH_TOKEN points at GH_TOKEN and at a stale registry login" {
  pull_fails_with 'Error response from daemon: Head "https://ghcr.io/v2/acme/media-service/manifests/9f25493": denied: denied'
  [[ $output == *"A private image needs GH_TOKEN"* ]]
  [[ $output == *"docker logout ghcr.io"* ]]
}

@test "a refused pull with GH_TOKEN says the token can't read the image" {
  pull_fails_with 'Error response from daemon: Head "https://ghcr.io/v2/acme/media-service/manifests/9f25493": unauthorized' \
    GH_TOKEN=ghp_testtoken1234567890
  [[ $output == *"GH_TOKEN can't read this image"* ]]
  [[ $output == *"read:packages"* ]]
  [[ $output != *ghp_testtoken1234567890* ]]
}

@test "any other failed pull names the reason and where to look" {
  pull_fails_with 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host'
  [[ $output == *"can this server reach ghcr.io"* ]]
  [[ $output != *GH_TOKEN* ]]
}

@test "an existing Docker daemon.json is kept and Docker is not restarted" {
  mkdir -p /etc/docker
  echo '{"debug": true}' >/etc/docker/daemon.json
  first_install
  [ "$(cat /etc/docker/daemon.json)" = '{"debug": true}' ]
  [[ $output == *"Keeping the existing /etc/docker/daemon.json"* ]]
  run grep -c "systemctl restart docker" "$CALLS_LOG"
  [ "$output" = 0 ]
}

@test "a Docker without the DOCKER-USER chain is refused" {
  run_installer MEDIA_DIR="$MEDIA" MEDIA_IMAGE=ghcr.io/acme/media-service STUB_IPTABLES_EXIT=1
  [ "$status" -eq 1 ]
  [[ $output == *"DOCKER-USER firewall chain is missing"* ]]
  run grep -c "docker compose up" "$CALLS_LOG"
  [ "$output" = 0 ]
}

@test "a port another stack holds stops the install before the firewall, and the setting it names fixes it" {
  run_installer MEDIA_DIR="$MEDIA" MEDIA_IMAGE=ghcr.io/acme/media-service \
    STUB_LISTENERS="$AI_SERVER_LISTENERS" STUB_PUBLISHERS=3000=ai-server-webui-1
  [ "$status" -eq 1 ]
  [[ $output == *"Port 127.0.0.1:3000 (API_PORT) is already in use by container ai-server-webui-1."* ]]
  [[ $output == *"Set API_PORT in $MEDIA/.env to a free port, then run the installer again."* ]]
  run grep -c -e "media-egress-firewall" -e "models.sh sync" -e "docker compose up" "$CALLS_LOG"
  [ "$output" = 0 ]
  set_env_var "$MEDIA/.env" API_PORT 3001
  run_installer MEDIA_DIR="$MEDIA" STUB_LISTENERS="$AI_SERVER_LISTENERS" STUB_PUBLISHERS=3000=ai-server-webui-1
  [ "$status" -eq 0 ]
  [[ $output == *"API key  mk_test_default_"* ]]
}

@test "the bundled proxy's port is checked on HTTP_BIND, and not at all without the proxy profile" {
  nginx='LISTEN 0 511 203.0.113.10:8085 0.0.0.0:* users:(("nginx",pid=900,fd=6))'
  first_install STUB_LISTENERS="$nginx"
  open="$BATS_TEST_TMPDIR/open"
  run_installer MEDIA_DIR="$open" MEDIA_IMAGE=ghcr.io/acme/media-service HTTP_BIND=0.0.0.0 STUB_LISTENERS="$nginx"
  [ "$status" -eq 1 ]
  [[ $output == *"Port 0.0.0.0:8085 (HTTP_PORT) is already in use by nginx."* ]]
  set_env_var "$open/.env" COMPOSE_PROFILES local-db,local-redis
  run_installer MEDIA_DIR="$open" STUB_LISTENERS="$nginx"
  [ "$status" -eq 0 ]
}

@test "on updates the stack's own containers holding its ports are no collision" {
  first_install
  run_installer MEDIA_DIR="$MEDIA" STUB_OWN_PORTS="3000 8085" STUB_PUBLISHERS="3000=media-api-1 8085=media-proxy-1" \
    STUB_LISTENERS=$'LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:* users:(("docker-proxy",pid=7,fd=7))\nLISTEN 0 4096 127.0.0.1:8085 0.0.0.0:* users:(("docker-proxy",pid=8,fd=7))'
  [ "$status" -eq 0 ]
  grep -q "docker ps -q --filter label=com.docker.compose.project=media --filter publish=3000" "$CALLS_LOG"
  grep -q "docker ps -q --filter label=com.docker.compose.project=media --filter publish=8085" "$CALLS_LOG"
}

@test "API_PORT in .env must be a port number" {
  first_install
  set_env_var "$MEDIA/.env" API_PORT 30o0
  run_installer MEDIA_DIR="$MEDIA"
  [ "$status" -eq 1 ]
  [[ $output == *"API_PORT in $MEDIA/.env must be a port number (1-65535), not '30o0'."* ]]
}

@test "a failed docker compose up shows Docker's own error, not only where to look" {
  run_installer MEDIA_DIR="$MEDIA" MEDIA_IMAGE=ghcr.io/acme/media-service STUB_COMPOSE_UP_EXIT=1 \
    STUB_COMPOSE_UP_ERROR='Error response from daemon: Bind for 127.0.0.1:3000 failed: port is already allocated'
  [ "$status" -eq 1 ]
  [[ $output == *"The services did not start: Error response from daemon: Bind for 127.0.0.1:3000 failed: port is already allocated"* ]]
  [[ $output == *"docker compose logs <service>"* ]]
  grep -q "Container media-api-1  Starting" /var/log/media-install.log
}

# --- outside database (SPEC §17a) ---------------------------------------------------------------

OUTSIDE_DB='postgres://media:s3cret-pw@db.example.com:5432/media'

@test "an outside DATABASE_URL replaces the bundled Postgres, verifies TLS and is checked before the firewall" {
  first_install DATABASE_URL="$OUTSIDE_DB"
  [[ $output == *"Checking the database at db.example.com"* ]]
  env_file="$MEDIA/.env"
  [ "$(get_env_var "$env_file" DATABASE_URL)" = "$OUTSIDE_DB" ]
  [ "$(get_env_var "$env_file" COMPOSE_PROFILES)" = local-redis,proxy ]
  [ "$(get_env_var "$env_file" DATABASE_SSL_MODE)" = verify-full ]
  run get_env_var "$env_file" DATABASE_SSL_CA_FILE
  [ "$status" -eq 1 ]
  (( $(call_line "docker compose run --rm --no-deps migrate") < $(call_line "systemctl restart media-egress-firewall.service") ))
  (( $(call_line "docker compose run --rm --no-deps migrate") < $(call_line "models.sh sync") ))
}

@test "the outside database's password reaches neither the terminal nor the log" {
  first_install DATABASE_URL="$OUTSIDE_DB"
  [[ $output != *s3cret-pw* ]]
  run grep -c s3cret-pw /var/log/media-install.log
  [ "$output" = 0 ]
}

@test "a database the server can't reach stops the install before the firewall, naming the host and the cause" {
  run_installer MEDIA_DIR="$MEDIA" MEDIA_IMAGE=ghcr.io/acme/media-service DATABASE_URL="$OUTSIDE_DB" \
    STUB_DB_ERROR='Migrations failed: getaddrinfo ENOTFOUND db.example.com'
  [ "$status" -eq 1 ]
  [[ $output == *"The database at db.example.com did not answer: Migrations failed: getaddrinfo ENOTFOUND db.example.com"* ]]
  [[ $output == *"DATABASE_URL"* ]]
  [[ $output != *s3cret-pw* ]]
  run grep -c -e "systemctl restart media-egress-firewall.service" -e "docker compose up" "$CALLS_LOG"
  [ "$output" = 0 ]
}

@test "DATABASE_SSL_CA_FILE is copied next to the stack and points at its /certs mount" {
  printf -- '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n' >"$BATS_TEST_TMPDIR/supabase-ca.crt"
  first_install DATABASE_URL="$OUTSIDE_DB" DATABASE_SSL_CA_FILE="$BATS_TEST_TMPDIR/supabase-ca.crt"
  cmp "$BATS_TEST_TMPDIR/supabase-ca.crt" "$MEDIA/certs/database-ca.pem"
  [ "$(stat -c %a "$MEDIA/certs/database-ca.pem")" = 644 ]
  [ "$(get_env_var "$MEDIA/.env" DATABASE_SSL_CA_FILE)" = /certs/database-ca.pem ]
}

@test "invalid outside-database settings stop the install before anything changes, without echoing the URL" {
  run_installer MEDIA_DIR="$MEDIA" DATABASE_URL='mysql://user:pw-mysql@db.example.com/media'
  [ "$status" -eq 1 ]
  [[ $output == *"DATABASE_URL must be a postgres:// URL"* ]]
  [[ $output != *pw-mysql* ]]
  run_installer MEDIA_DIR="$MEDIA" DATABASE_URL="$OUTSIDE_DB" DATABASE_SSL_MODE=strict
  [ "$status" -eq 1 ]
  [[ $output == *"DATABASE_SSL_MODE must be disable, require, verify-ca or verify-full, not 'strict'."* ]]
  run_installer MEDIA_DIR="$MEDIA" DATABASE_URL="$OUTSIDE_DB" DATABASE_SSL_CA_FILE=/nonexistent/ca.pem
  [ "$status" -eq 1 ]
  [[ $output == *"DATABASE_SSL_CA_FILE '/nonexistent/ca.pem' is not a readable file."* ]]
  run_installer MEDIA_DIR="$MEDIA" DATABASE_SSL_MODE=require
  [ "$status" -eq 1 ]
  [[ $output == *"DATABASE_SSL_MODE is only used with an outside DATABASE_URL."* ]]
  [ ! -s "$CALLS_LOG" ]
  [ ! -e "$MEDIA" ]
}

@test "the bundled database is not checked early" {
  first_install
  run grep -c "docker compose run" "$CALLS_LOG"
  [ "$output" = 0 ]
  [ "$(get_env_var "$MEDIA/.env" COMPOSE_PROFILES)" = local-db,local-redis,proxy ]
}

@test "updates keep the outside database's settings and check it again" {
  first_install DATABASE_URL="$OUTSIDE_DB"
  : >"$CALLS_LOG"
  run_installer MEDIA_DIR="$MEDIA" DATABASE_URL='postgres://other:pw@elsewhere.example.com/x'
  [ "$status" -eq 0 ]
  [[ $output == *"DATABASE_URL is only used on the first install"* ]]
  [ "$(get_env_var "$MEDIA/.env" DATABASE_URL)" = "$OUTSIDE_DB" ]
  grep -q "docker compose run --rm --no-deps migrate" "$CALLS_LOG"
}

@test "piped into bash, as in the curl one-liner, the script runs main" {
  run bash -c 'cat "$1" | env MEDIA_DIR="$2" MEDIA_IMAGE=ghcr.io/acme/media-service HTTP_PORT=abc bash' \
    _ "$INSTALL_SH" "$MEDIA"
  [ "$status" -eq 1 ]
  [[ $output == *"HTTP_PORT must be a port number"* ]]
}

@test "the script refuses to run without root" {
  run setpriv --reuid=65534 --regid=65534 --clear-groups bash "$INSTALL_SH"
  [ "$status" -eq 1 ]
  [[ $output == *"Run as root"* ]]
}

# --- deploy.sh ----------------------------------------------------------------------------------

@test "deploy.sh requires exactly one release argument" {
  run "$BATS_TEST_DIRNAME/../deploy.sh"
  [ "$status" -eq 2 ] && [[ $output == *"Usage:"* ]]
}

@test "deploy.sh runs install.sh from its own directory with the release pinned" {
  dir="$BATS_TEST_TMPDIR/srv"
  mkdir -p "$dir"
  cp "$BATS_TEST_DIRNAME/../deploy.sh" "$dir/"
  printf '#!/usr/bin/env bash\necho "$MEDIA_DIR $MEDIA_VERSION"\n' >"$dir/install.sh"
  chmod +x "$dir/install.sh"
  run "$dir/deploy.sh" abc1234
  [ "$status" -eq 0 ]
  [ "$output" = "$dir abc1234" ]
}
