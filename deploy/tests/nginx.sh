#!/usr/bin/env bash
# Checks the shipped nginx configuration with the bundled proxy's own image (DEPLOY.md §4.4):
#   - nginx -t for the bundled proxy template (rendered as the image does), the host vhost with
#     its zones, and the TLS front;
#   - the host vhost and the bundled proxy have the same locations and limits.
#   deploy/tests/nginx.sh
set -euo pipefail

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
image=$(sed -n 's/^ *image: \(nginx:[^ ]*\).*/\1/p' "$deploy_dir/docker-compose.yml" | head -1)
failures=0
check() {  # <description> <command...>
  local description=$1
  shift
  if "$@" >/tmp/nginx-check.log 2>&1; then echo "ok    $description"; else echo "FAIL  $description"; cat /tmp/nginx-check.log; failures=$((failures + 1)); fi
}
nginx_t() {  # <docker args...>: nginx -t in the pinned image
  docker run --rm --add-host api:127.0.0.1 "$@" "$image" nginx -t
}

# The image renders templates with envsubst at start; do the same, then test.
check "bundled proxy template ($image)" docker run --rm --add-host api:127.0.0.1 \
  -e API_PORT=3000 -e MAX_UPLOAD_SIZE_MB=4096 \
  -v "$deploy_dir/nginx/proxy.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  --entrypoint sh "$image" -c '/docker-entrypoint.d/20-envsubst-on-templates.sh >/dev/null && nginx -t'
check "host vhost with its rate-limit zones" nginx_t \
  -v "$deploy_dir/nginx/media-zones.conf:/etc/nginx/conf.d/media-zones.conf:ro" \
  -v "$deploy_dir/nginx/media.conf:/etc/nginx/conf.d/media.conf:ro"
check "TLS front for the bundled proxy" nginx_t \
  -v "$deploy_dir/nginx/front.conf:/etc/nginx/conf.d/default.conf:ro"

# Each location with its directives; values that differ by design (paths, size, allow lists) dropped.
locations() {
  awk '
    /^ *location / { name = $0; sub(/^ */, "", name); sub(/ *\{$/, "", name); inside = 1; next }
    inside && /^ *}/ { inside = 0; next }
    inside {
      line = $0; sub(/^ */, "", line); sub(/;$/, "", line)
      if (line ~ /^(alias|client_max_body_size|allow|deny) /) sub(/ .*/, "", line)
      if (line != "" && line !~ /^#/) print name " :: " line
    }
  ' "$1" | sort -u
}
check "host vhost and bundled proxy have the same locations and limits" \
  diff <(locations "$deploy_dir/nginx/proxy.conf.template") <(locations "$deploy_dir/nginx/media.conf")
check "both define the API, upload and download zones" sh -c "
  for zone in media_api media_uploads media_downloads; do
    grep -q \"zone=\$zone:\" '$deploy_dir/nginx/proxy.conf.template' && grep -q \"zone=\$zone:\" '$deploy_dir/nginx/media-zones.conf' || exit 1
  done"

if [ "$failures" -gt 0 ]; then echo "$failures nginx check(s) failed"; exit 1; fi
echo "nginx checks passed"
