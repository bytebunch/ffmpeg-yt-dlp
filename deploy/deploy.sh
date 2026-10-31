#!/usr/bin/env bash
# Installs a specific release, or rolls back to one: sudo ./deploy.sh <git-sha>
# Installed releases are listed in .release-history, newest last. Re-running install.sh with a
# pinned MEDIA_VERSION is the whole procedure, so this stays a thin wrapper.
set -euo pipefail

if (( $# != 1 )); then
  echo "Usage: sudo $0 <git-sha>   (installed releases: .release-history)" >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
exec env MEDIA_DIR="$here" MEDIA_VERSION="$1" "$here/install.sh"
