#!/usr/bin/env bash
# End-to-end test of the production image and the deploy/ bundle on this machine:
# builds media-service on media-ffmpeg, lays out an install directory the way install.sh does,
# starts the stack (bundled Postgres, Redis and nginx proxy), runs deploy/smoke.sh through the
# proxy, then checks container hardening, bundled binaries and a restart.
#   scripts/e2e.sh            FFMPEG_IMAGE=... scripts/e2e.sh            scripts/e2e.sh --keep
# YouTube often refuses datacenter IPs such as CI runners' ("Sign in to confirm you're not a bot").
# With E2E_ALLOW_YOUTUBE_BLOCK=1 (ci.yml, rebuild.yml) that answer, and only that one, skips the
# YouTube checks; everywhere else they must pass.
# Written for the bash 3.2 that macOS ships.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
ffmpeg_image=${FFMPEG_IMAGE:-media-ffmpeg:dev}
http_port=18080
api_port=13000
keep=0
if [ "${1:-}" = "--keep" ]; then keep=1; fi
# One-off containers that read or write the install directory run as this user: on Linux the
# image's UID 10001 cannot enter the mktemp directory (0700).
host_user="$(id -u):$(id -g)"

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
check() {  # <description> <command...>
  local description=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$description"; else fail "$description"; fi
}

echo "--- building media-service:e2e on $ffmpeg_image"
# YTDLP_VERSION: test another yt-dlp than the Dockerfile's (the Rebuild workflow).
docker build -q --build-arg "FFMPEG_IMAGE=$ffmpeg_image" --build-arg GIT_SHA=e2e0000 \
  ${YTDLP_VERSION:+--build-arg "YTDLP_VERSION=$YTDLP_VERSION"} \
  -t media-service:e2e "$root" >/dev/null

dir=$(mktemp -d "${TMPDIR:-/tmp}/media-e2e.XXXXXX")
compose() { docker compose --project-directory "$dir" "$@"; }
cleanup() {
  if [ "$keep" = 1 ]; then
    echo "--- kept: $dir (stop with: docker compose --project-directory $dir down -v)"
    return
  fi
  # Attached to the stack's networks, so it goes first.
  docker rm -f media-e2e-host-vhost >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || echo "warning: compose down failed for $dir"
  # The services wrote files as their own users (10001, postgres, redis); on Linux only root can
  # remove those.
  docker run --rm --user 0 -v "$dir:/out" --entrypoint find media-service:e2e /out -mindepth 1 -delete \
    >/dev/null 2>&1 || true
  rm -rf "$dir"
}
trap cleanup EXIT

echo "--- install directory $dir"
cp -R "$root/deploy/." "$dir/"
rm -rf "$dir/tests"
mkdir -p "$dir/files" "$dir/inbox/e2e" "$dir/models" "$dir/backups"
# The containers run as UID 10001; install.sh chowns these on a server, a test directory just opens them.
chmod 0777 "$dir/files" "$dir/backups"
# Transcription runs when the base model is cached (docker/ffmpeg/test.sh downloads it).
model_cache=${MODEL_CACHE:-$HOME/.cache/media-ffmpeg-models}
transcribe=0
if [ -f "$model_cache/ggml-base-q8_0.bin" ]; then
  cp "$model_cache/ggml-base-q8_0.bin" "$dir/models/"
  transcribe=1
fi
password=$(openssl rand -hex 24)
set_env() {  # <key> <value>: replaces KEY=... in .env (values here contain no '|')
  sed -i.bak "s|^$1=.*|$1=$2|" "$dir/.env" && rm -f "$dir/.env.bak"
}
cp "$dir/.env.example" "$dir/.env"
set_env COMPOSE_PROJECT_NAME media-e2e
set_env MEDIA_IMAGE media-service
set_env IMAGE_TAG e2e
set_env HTTP_PORT "$http_port"
set_env HTTP_BIND 127.0.0.1
set_env API_PORT "$api_port"
set_env PUBLIC_BASE_URL "http://127.0.0.1:$http_port"
set_env POSTGRES_PASSWORD "$password"
set_env DATABASE_URL "postgres://ytdlp_app:$password@postgres:5432/media"
set_env LINK_SIGNING_SECRET "$(openssl rand -hex 32)"
set_env TOKEN_ENCRYPTION_KEYS "v1:$(openssl rand -base64 32)"
# The host disk is not under test (the disk guard has its own integration test).
echo "DISK_QUOTA_PERCENT=99" >>"$dir/.env"
if [ "$transcribe" = 1 ]; then
  # models.sh writes the same lines on a real install; only the VAD file is left out here.
  "$dir/models.sh" env fast | grep -v VAD_MODEL | while IFS= read -r line; do echo "$line" >>"$dir/.env"; done
fi

echo "--- starting the stack"
compose up -d --quiet-pull 2>&1 | tail -3

api_health() { docker inspect --format '{{ .State.Health.Status }}' "$(compose ps -q api)" 2>/dev/null || true; }
wait_healthy() {
  local _
  for _ in $(seq 1 60); do
    if [ "$(api_health)" = healthy ]; then return 0; fi
    sleep 2
  done
  return 1
}
if ! wait_healthy; then
  compose logs --tail 40 api migrate
  echo "FAIL  the API never became healthy"
  exit 1
fi
pass "stack healthy (migrate → api → proxy)"

migrate_exit=$(docker inspect --format '{{ .State.ExitCode }}' "$(compose ps -a -q migrate)")
check "migrate exited 0" test "$migrate_exit" = 0

key=$(compose exec -T api cli keys:create e2e --quiet)
check "cli keys:create printed a key" grep -Eq '^mk_[A-Za-z0-9_-]{32}$' <<<"$key"

api() {  # <method> <path> [JSON body]
  if [ $# -ge 3 ]; then
    curl -s -X "$1" -H "Authorization: Bearer $key" -H 'x-user-id: e2e' -H 'content-type: application/json' \
      -d "$3" "http://127.0.0.1:$http_port$2"
  else
    curl -s -X "$1" -H "Authorization: Bearer $key" -H 'x-user-id: e2e' "http://127.0.0.1:$http_port$2"
  fi
}
field() { python3 -c "import json,sys; print(json.load(sys.stdin)[sys.argv[1]])" "$1"; }
youtube=reachable
youtube_blocked() {  # true only when allowed and YouTube answers BOT_CHECK
  local answer
  [ "${E2E_ALLOW_YOUTUBE_BLOCK:-0}" = 1 ] || return 1
  answer=$(api POST /v1/info '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}')
  case "$answer" in *'"code":"BOT_CHECK"'*) return 0 ;; esac
  return 1
}
skip_youtube() {  # <what is skipped>
  echo "warn  $1 skipped: YouTube refuses this machine's IP (BOT_CHECK)"
}

echo "--- deploy/smoke.sh through the proxy"
smoke_strict=1
if youtube_blocked; then
  youtube=blocked
  smoke_strict=0
  skip_youtube "the real-site part of smoke.sh"
fi
if BASE_URL="http://127.0.0.1:$http_port" API_KEY="$key" SMOKE_STRICT=$smoke_strict "$dir/smoke.sh"; then
  pass "smoke.sh"
else
  fail "smoke.sh"
fi

echo "--- hardening and binaries"
check "API published on 127.0.0.1:$api_port" curl -fs "http://127.0.0.1:$api_port/health"
check "proxy refuses unknown paths" test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$http_port/secret")" = 404
check "metrics reachable from a private address" sh -c "curl -fs http://127.0.0.1:$http_port/metrics | grep -q http_request_duration_seconds"
check "runs as uid 10001" test "$(compose exec -T api id -u)" = 10001
check "root filesystem is read-only" sh -c "! docker compose --project-directory '$dir' exec -T api touch /app/probe"
check "/tmp is writable" compose exec -T api touch /tmp/probe
check "files volume is writable" compose exec -T api touch /data/files/probe
check "inbox is read-only" sh -c "! docker compose --project-directory '$dir' exec -T api touch /data/inbox/probe"
check "yt-dlp is installed" compose exec -T api yt-dlp --version
check "deno is installed" compose exec -T api deno --version
check "ffmpeg 8.1 with whisper" sh -c "docker compose --project-directory '$dir' exec -T api ffmpeg -hide_banner -buildconf | grep -q enable-whisper"
check "fonts are installed" sh -c "docker compose --project-directory '$dir' exec -T api sh -c 'ls /usr/share/fonts/truetype/dejavu /usr/share/fonts/opentype/noto' "
check "deployment bundle at /app/deploy" compose exec -T api test -f /app/deploy/docker-compose.yml
check "image carries the revision label" test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' media-service:e2e)" = e2e0000
check "API keys are not in the container environment" sh -c "! docker compose --project-directory '$dir' exec -T api env | grep -q '^mk_'"

echo "--- PO-token provider"
pot_health() { docker inspect --format '{{ .State.Health.Status }}' "$(compose ps -q pot-provider)" 2>/dev/null || true; }
for _ in $(seq 1 30); do [ "$(pot_health)" = healthy ] && break; sleep 2; done
check "pot-provider is healthy" test "$(pot_health)" = healthy
check "worker-dl reaches the provider" compose exec -T worker-dl node -e \
  "fetch(process.env.YTDLP_POT_PROVIDER_URL+'/ping').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# A real YouTube extraction: the plugin must be loaded and its server reachable (not "unavailable").
check "yt-dlp uses the bgutil plugin" sh -c "docker compose --project-directory '$dir' exec -T worker-dl sh -c \
  'yt-dlp -v --ignore-config --no-cache-dir --simulate --no-playlist --js-runtimes deno:/usr/local/bin/deno \
   --extractor-args youtubepot-bgutilhttp:base_url=\$YTDLP_POT_PROVIDER_URL -- https://www.youtube.com/watch?v=jNQXAC9IVRw 2>&1' \
  | grep -Eq 'bgutil:http-[0-9.]+ \(external\)'"

echo "--- resumable upload through nginx (tus)"
docker run --rm --user "$host_user" -v "$dir:/out" --entrypoint ffmpeg media-service:e2e \
  -hide_banner -loglevel error -f lavfi -i testsrc2=size=160x120:rate=10:duration=1 -c:v libx264 -y /out/upload.mp4
upload_size=$(wc -c <"$dir/upload.mp4" | tr -d ' ')
created=$(curl -s -H "Authorization: Bearer $key" -H 'x-user-id: e2e' -H 'content-type: application/json' \
  -d "{\"filename\":\"upload.mp4\",\"size\":$upload_size}" "http://127.0.0.1:$http_port/v1/uploads")
upload_id=$(printf '%s' "$created" | field uploadId)
upload_token=$(printf '%s' "$created" | field uploadToken)
patch_code=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $upload_token" -H 'Tus-Resumable: 1.0.0' -H 'Upload-Offset: 0' \
  -H 'Content-Type: application/offset+octet-stream' --data-binary "@$dir/upload.mp4" \
  "http://127.0.0.1:$http_port/u/$upload_id")
check "tus PATCH through nginx answers 204" test "$patch_code" = 204
upload_status=$(curl -s -H "Authorization: Bearer $key" -H 'x-user-id: e2e' "http://127.0.0.1:$http_port/v1/uploads/$upload_id" | field status)
check "the upload was probed and is ready" test "$upload_status" = ready
probe_code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $key" -H 'x-user-id: e2e' -H 'content-type: application/json' \
  -d "{\"input\":{\"type\":\"upload\",\"uploadId\":\"$upload_id\"}}" "http://127.0.0.1:$http_port/v1/probe")
check "the upload probes as an input" test "$probe_code" = 200

echo "--- worker-ff runs a recipe on the upload"
check "worker-ff is running" test "$(docker inspect --format '{{ .State.Status }}' "$(compose ps -q worker-ff)")" = running
check "worker-ff runs as uid 10001" test "$(compose exec -T worker-ff id -u)" = 10001
check "models are read-only in worker-ff" sh -c "! docker compose --project-directory '$dir' exec -T worker-ff touch /models/probe"
recipe='{"type":"process","inputs":[{"type":"upload","uploadId":"'"$upload_id"'"}],"recipe":{"steps":[{"op":"scale","width":80,"height":60},{"op":"encode","name":"small","container":"mp4"},{"op":"thumbnail","name":"poster"},{"op":"hls","name":"stream","segment_s":2,"variants":[{"height":144,"video_bitrate_kbps":200}]}]}}'
process_id=$(curl -s -H "Authorization: Bearer $key" -H 'x-user-id: e2e' -H 'content-type: application/json' \
  -d "$recipe" "http://127.0.0.1:$http_port/v1/jobs" | field id)
process_status=queued
process_job='{}'
for _ in $(seq 1 60); do
  process_job=$(curl -s -H "Authorization: Bearer $key" -H 'x-user-id: e2e' "http://127.0.0.1:$http_port/v1/jobs/$process_id")
  process_status=$(printf '%s' "$process_job" | field status)
  case "$process_status" in completed | failed | cancelled) break ;; esac
  sleep 1
done
check "the process job completed" test "$process_status" = completed
[ "$process_status" = completed ] || printf '%s\n' "$process_job"
output_url=$(printf '%s' "$process_job" | python3 -c "import json,sys; print(json.load(sys.stdin)['outputs'][0]['url'])" 2>/dev/null || true)
check "the recipe output downloads through nginx" \
  sh -c "curl -fs -o '$dir/small.mp4' '$output_url' && test -s '$dir/small.mp4'"
# The host vhost (nginx/media.conf) in front of the same stack: only its upstream and files path differ.
sed -e "s|server 127.0.0.1:3000;|server api:$api_port;|" -e "s|alias /mnt/media-files/;|alias /data/files/;|" \
  "$dir/nginx/media.conf" >"$dir/host-vhost.conf"
vhost_port=$((http_port + 1))
# nginx resolves the upstream at start, so both networks are attached before it starts.
docker create --name media-e2e-host-vhost --network media-e2e_edge -p "127.0.0.1:$vhost_port:80" \
  -v "$dir/nginx/media-zones.conf:/etc/nginx/conf.d/media-zones.conf:ro" \
  -v "$dir/host-vhost.conf:/etc/nginx/conf.d/media.conf:ro" -v "$dir/files:/data/files:ro" \
  "$(sed -n 's/^ *image: \(nginx:[^ ]*\).*/\1/p' "$dir/docker-compose.yml" | head -1)" >/dev/null
docker network connect media-e2e_backend media-e2e-host-vhost
docker start media-e2e-host-vhost >/dev/null
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$vhost_port/" && break; sleep 0.5; done
[ "$(docker inspect --format '{{ .State.Running }}' media-e2e-host-vhost)" = true ] || docker logs media-e2e-host-vhost
vhost_url=$(printf '%s' "$output_url" | sed "s|127.0.0.1:$http_port|127.0.0.1:$vhost_port|")
# Requests carry the vhost's name, as real traffic does (the image's default site answers the rest).
vhost_host='Host: dl.example.com'
check "host vhost: a signed link answers a Range request (206)" \
  test "$(curl -s -o /dev/null -w '%{http_code}' -H "$vhost_host" -r 0-99 "$vhost_url")" = 206
check "host vhost: the API answers through it" \
  test "$(curl -s -o /dev/null -w '%{http_code}' -H "$vhost_host" -H "Authorization: Bearer $key" "http://127.0.0.1:$vhost_port/v1/presets")" = 200
check "host vhost: /health is closed to other addresses" \
  test "$(curl -s -o /dev/null -w '%{http_code}' -H "$vhost_host" "http://127.0.0.1:$vhost_port/health")" = 403
[ "$keep" = 1 ] || docker rm -f media-e2e-host-vhost >/dev/null

hls_url=$(printf '%s' "$process_job" | python3 -c "import json,sys; print([o['url'] for o in json.load(sys.stdin)['outputs'] if o['role']=='package'][0])" 2>/dev/null || true)
check "the HLS playlist downloads through nginx" sh -c "curl -fs '$hls_url' | grep -q '#EXTM3U'"
check "files inside the HLS package download through nginx" sh -c "curl -fs '${hls_url%master.m3u8}v0/index.m3u8' | grep -q '#EXTINF'"
check "the recipe output is 80x60" sh -c \
  "docker run --rm --user $host_user -v '$dir:/out' --entrypoint ffprobe media-service:e2e -v error -show_entries stream=width,height -of csv=p=0 /out/small.mp4 | grep -q '^80,60'"

if [ "$transcribe" = 1 ]; then
  echo "--- transcribe with whisper.cpp on worker-ff"
  docker run --rm --entrypoint cat media-service:e2e /usr/local/share/media-ffmpeg/jfk.wav >"$dir/inbox/e2e/jfk.wav"
  speech='{"type":"process","inputs":[{"type":"inbox","name":"jfk.wav"}],"recipe":{"steps":[{"op":"transcribe","language":"en","format":"srt"}]}}'
  speech_id=$(curl -s -H "Authorization: Bearer $key" -H 'x-user-id: e2e' -H 'content-type: application/json' \
    -d "$speech" "http://127.0.0.1:$http_port/v1/jobs" | field id)
  speech_job='{}'
  for _ in $(seq 1 90); do
    speech_job=$(curl -s -H "Authorization: Bearer $key" -H 'x-user-id: e2e' "http://127.0.0.1:$http_port/v1/jobs/$speech_id")
    case "$(printf '%s' "$speech_job" | field status)" in completed | failed | cancelled) break ;; esac
    sleep 1
  done
  srt_url=$(printf '%s' "$speech_job" | python3 -c "import json,sys; print(json.load(sys.stdin)['outputs'][0]['url'])" 2>/dev/null || true)
  check "the transcript says what JFK said" sh -c "curl -fs '$srt_url' | tr 'A-Z' 'a-z' | grep -q 'ask not what your country can do for you'"
  [ -n "$srt_url" ] || printf '%s\n' "$speech_job"
else
  echo "warn  transcribe check skipped: no cached whisper model in $model_cache"
fi

echo "--- cookies and watches through nginx"
jar=$(python3 -c 'import json; print(json.dumps({"cookies": ".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tsecret-e2e\n", "label": "e2e"}))')
api PUT /v1/cookies "$jar" >"$dir/jar.json"
check "a cookie jar is stored" grep -q '"domains":\["youtube.com"\]' "$dir/jar.json"
api GET /v1/cookies >"$dir/jars.json"
check "cookie contents are never returned" sh -c "grep -q '\"label\":\"e2e\"' '$dir/jars.json' && ! grep -q secret-e2e '$dir/jars.json'"
watch_id=$(api POST /v1/watches '{"url":"https://www.youtube.com/@LofiGirl/videos","interval_minutes":60}' | field id)
check "a watch is created" sh -c "printf '%s' '$watch_id' | grep -Eq '^[0-9a-f-]{36}$'"
check "the watch is deleted" sh -c "curl -s -X DELETE -H 'Authorization: Bearer $key' -H 'x-user-id: e2e' \
  'http://127.0.0.1:$http_port/v1/watches/$watch_id' | grep -q '\"removed\":1'"

check "Drive is off without GOOGLE_* (501)" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $key" -H 'x-user-id: e2e' "http://127.0.0.1:$http_port/v1/drive/connect")" = 501
check "the OAuth callback page is public through nginx" sh -c \
  "curl -s 'http://127.0.0.1:$http_port/oauth/google/callback?state=x&code=y' | grep -q 'Google Drive not connected'"

if [ "${E2E_LIVE:-1}" != 1 ]; then
  echo "warn  live recording check skipped (E2E_LIVE=0)"
elif [ "$youtube" = blocked ] || youtube_blocked; then
  youtube=blocked
  skip_youtube "live recording check"
else
  echo "--- live recording (a real YouTube live stream, stopped with SIGINT)"
  live_id=$(api POST /v1/jobs '{"type":"record","url":"https://www.youtube.com/@LofiGirl/live","preset":"360p","max_duration_minutes":5}' | field id)
  recorded_bytes() { api GET "/v1/jobs/$live_id" | python3 -c "import json,sys; print((json.load(sys.stdin).get('progress') or {}).get('bytes') or 0)"; }
  for _ in $(seq 1 90); do [ "$(recorded_bytes)" -gt 0 ] && break; sleep 1; done
  check "the recording is receiving data" test "$(recorded_bytes)" -gt 0
  sleep 15
  api DELETE "/v1/jobs/$live_id" >/dev/null
  live_job='{}'
  for _ in $(seq 1 180); do
    live_job=$(api GET "/v1/jobs/$live_id")
    case "$(printf '%s' "$live_job" | field status)" in completed | failed | cancelled) break ;; esac
    sleep 1
  done
  live_url=$(printf '%s' "$live_job" | python3 -c "import json,sys; print(json.load(sys.stdin)['outputs'][0]['url'])" 2>/dev/null || true)
  check "a stopped recording keeps an MP4" sh -c "curl -fs -o '$dir/live.mp4' '$live_url' && test -s '$dir/live.mp4'"
  [ -n "$live_url" ] || printf '%s\n' "$live_job"
  # One value per line: the format name itself contains commas (mov,mp4,m4a,…).
  check "the recording is a remuxed MP4 of more than 10 s" sh -c \
    "docker run --rm --user $host_user -v '$dir:/out' --entrypoint ffprobe media-service:e2e -v error -show_entries format=format_name,duration -of default=nw=1 /out/live.mp4 \
     | awk -F= '\$1 == \"format_name\" && \$2 ~ /mp4/ { mp4 = 1 } \$1 == \"duration\" && \$2 > 10 { long = 1 } END { exit !(mp4 && long) }'"
fi

echo "--- backups"
check "the backup service is running" \
  test "$(docker inspect --format '{{ .State.Status }}' "$(compose ps -q backup)")" = running
check "a dump is written" compose exec -T backup media-backup once
dump=$(find "$dir/backups" -name 'media-*.dump' | head -1)
check "the dump restores into a scratch database" sh -c "
  docker compose --project-directory '$dir' exec -T postgres createdb -U ytdlp_app restore_check &&
  docker compose --project-directory '$dir' exec -T postgres pg_restore -U ytdlp_app -d restore_check --no-owner <'$dump' &&
  test \"\$(docker compose --project-directory '$dir' exec -T postgres psql -U ytdlp_app -d restore_check -tAc 'SELECT count(*) FROM api_keys')\" -ge 1"

echo "--- MCP through nginx"
mcp() {  # <JSON-RPC body> <output file>
  curl -s -o "$2" -H "Authorization: Bearer $key" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -d "$1" "http://127.0.0.1:$http_port/mcp"
}
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$dir/mcp-tools.json"
check "MCP lists its tools" grep -q '"start_download"' "$dir/mcp-tools.json"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_jobs","arguments":{"user_id":"e2e"}}}' "$dir/mcp-call.json"
check "MCP tools answer (list_jobs)" grep -q 'jobs' "$dir/mcp-call.json"
check "MCP refuses requests without a key" test "$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$http_port/mcp")" = 401

echo "--- worker-dl and downloaded files"
check "worker-dl is running" test "$(docker inspect --format '{{ .State.Status }}' "$(compose ps -q worker-dl)")" = running
check "worker-dl runs as uid 10001" test "$(compose exec -T worker-dl id -u)" = 10001
check "worker-dl root filesystem is read-only" sh -c "! docker compose --project-directory '$dir' exec -T worker-dl touch /app/probe"
if [ "$youtube" = blocked ]; then
  skip_youtube "the smoke download's location check"
else
  check "the smoke download landed on the files volume as <jobId>/<outputId>/<name>" \
    sh -c "find '$dir/files' -mindepth 3 -maxdepth 3 -type f -name '*.mp4' | grep -q ."
fi
check "no work directories left behind" sh -c "[ -z \"\$(ls -A '$dir/files/.work' 2>/dev/null)\" ]"
check "tampered signed links are refused by nginx" \
  test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$http_port/d/00000000-0000-7000-8000-000000000000?exp=9999999999&sig=x")" = 404
check "internal file location is not reachable directly" \
  test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$http_port/_files/")" = 404

echo "--- restart keeps data"
compose restart api >/dev/null 2>&1
if wait_healthy; then pass "api healthy after restart"; else fail "api healthy after restart"; fi
check "the key still works after restart" curl -fs -H "Authorization: Bearer $key" "http://127.0.0.1:$http_port/v1/presets"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  compose logs --tail 30 api
  exit 1
fi
if [ "$youtube" = blocked ]; then
  # Shown on the run's summary page, so a pass without YouTube is never mistaken for a full one.
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::warning title=YouTube checks skipped::YouTube refused this runner's IP (BOT_CHECK); every other e2e check passed."
  fi
  echo "e2e passed (YouTube checks skipped: this IP is refused)"
else
  echo "e2e passed"
fi
