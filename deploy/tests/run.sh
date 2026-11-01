#!/usr/bin/env bash
# Lints and tests deploy/*.sh inside Ubuntu 24.04, the target platform (macOS ships bash 3.2,
# and the tests write to /etc and /usr/local as root, which only a throwaway container allows).
#   deploy/tests/run.sh
set -euo pipefail

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)

# nginx configuration, with the bundled proxy's own image.
"$deploy_dir/tests/nginx.sh"

# The compose file as Docker Compose resolves it: routes out for the database, the CA mount.
"$deploy_dir/tests/compose.sh"

docker run --rm -v "$deploy_dir:/deploy:ro" ubuntu:24.04 bash -euo pipefail -c '
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bats shellcheck openssl >/dev/null
  cd /deploy
  echo "--- shellcheck $(shellcheck --version | sed -n "s/^version: //p")"
  shellcheck install.sh deploy.sh smoke.sh models.sh backup.sh canary.sh host/egress-firewall.sh tests/run.sh tests/nginx.sh tests/compose.sh tests/install.bats tests/models.bats tests/firewall.bats tests/backup.bats tests/canary.bats tests/stubs/* \
    tests/fixtures/bundle/*.sh tests/fixtures/bundle/host/*.sh
  echo "OK"
  echo "--- bats $(bats --version)"
  bats tests/install.bats tests/models.bats tests/backup.bats tests/canary.bats
'

# The egress firewall with real iptables and network namespaces (needs a privileged container).
docker run --rm --privileged -v "$deploy_dir:/deploy:ro" ubuntu:24.04 bash -euo pipefail -c '
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bats iptables iproute2 netcat-openbsd procps >/dev/null
  echo "--- egress firewall ($(iptables --version))"
  bats /deploy/tests/firewall.bats
'
