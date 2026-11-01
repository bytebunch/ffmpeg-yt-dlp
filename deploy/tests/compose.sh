#!/usr/bin/env bash
# Checks deploy/docker-compose.yml as Docker Compose resolves it (all profiles on):
#   - every service that connects to DATABASE_URL or REDIS_URL has a route out, so an outside
#     Postgres or Redis (SPEC §17a) is reachable; the internal backend network alone has none;
#   - the app services mount ./certs read-only at /certs, where DATABASE_SSL_CA_FILE points.
#   deploy/tests/compose.sh
set -euo pipefail

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$deploy_dir/docker-compose.yml" "$work/"
: >"$work/.env"

MEDIA_IMAGE=ghcr.io/acme/media-service IMAGE_TAG=test POSTGRES_PASSWORD=test \
  docker compose --project-directory "$work" --profile local-db --profile local-redis --profile proxy \
  config --format json >"$work/config.json"

python3 -I - "$work/config.json" <<'EOF'
import json, sys

config = json.load(open(sys.argv[1]))
services, networks = config["services"], config["networks"]
failures = []

def check(description, ok):
    print(("ok    " if ok else "FAIL  ") + description)
    if not ok:
        failures.append(description)

for name in ("migrate", "api", "worker-dl", "worker-ff", "backup"):
    attached = services[name].get("networks", {})
    routed = [net for net in attached if not networks[net].get("internal", False)]
    check(f"{name} can reach an outside database (networks: {', '.join(attached)})", bool(routed))

for name in ("migrate", "api", "worker-dl", "worker-ff"):
    mounts = services[name].get("volumes", [])
    certs = [m for m in mounts if m.get("target") == "/certs"]
    check(f"{name} mounts ./certs read-only at /certs",
          len(certs) == 1 and certs[0].get("read_only") is True and certs[0]["source"].endswith("/certs"))

if failures:
    print(f"{len(failures)} compose check(s) failed")
    sys.exit(1)
print("compose checks passed")
EOF
