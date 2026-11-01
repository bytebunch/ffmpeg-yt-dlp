#!/usr/bin/env bash
#
# Media Service installer and updater (DEPLOY-QUICKSTART.md).
#
#   curl -fsSL https://raw.githubusercontent.com/bytebunch/ffmpeg-yt-dlp/main/deploy/install.sh | sudo bash
#
# First run: installs Docker, writes $MEDIA_DIR/.env with generated secrets, starts the stack on
# http://127.0.0.1:8085 (this server only) and prints the first API key. Later runs update to
# MEDIA_VERSION and keep .env as it is. deploy.sh <git-sha> runs this script to pin a version or
# roll back. Opening the service to other machines is the developer's choice: HTTP_BIND in .env,
# or their own nginx in front (DEPLOY-QUICKSTART.md, "Opening it up").
#
# Settings are environment variables on the command, e.g. `... | sudo HTTP_PORT=80 MODELS=fast bash`.
#   Every run
#     MEDIA_DIR         install directory                       /srv/media
#     MEDIA_VERSION     image tag to install (git SHA or main)  main
#     MEDIA_IMAGE       image repository                        from .env, else DEFAULT_IMAGE
#     GH_TOKEN          GitHub token for private images         none
#   First run only (afterwards, edit $MEDIA_DIR/.env)
#     MEDIA_FILES_PATH  host directory for output files         $MEDIA_DIR/files
#     HTTP_PORT         port of the bundled nginx               8085
#     HTTP_BIND         address the port is published on        127.0.0.1 (0.0.0.0: every interface)
#     PUBLIC_BASE_URL   external base URL used in links         http://<HTTP_BIND>:<HTTP_PORT>
#     MODELS            whisper models: all | fast | none       all
#     DATABASE_URL      an outside Postgres (Supabase, managed, your own) instead of the bundled one;
#                       it is checked before anything else starts
#     DATABASE_MIGRATION_URL  separate migration role for it    DATABASE_URL
#     DATABASE_SSL_MODE disable | require | verify-ca | verify-full   verify-full
#     DATABASE_SSL_CA_FILE  CA that signed the database's certificate (Supabase: from its
#                       dashboard); copied to $MEDIA_DIR/certs      the system's CAs
#
# What this script expects from the release it installs:
#   image   label org.opencontainers.image.revision = git SHA; the deployment bundle at /app/deploy;
#           `cli keys:create <client> --quiet` prints only the new key; `cli keys:revoke --key <key>`.
#   bundle  docker-compose.yml (app image ${MEDIA_IMAGE}:${IMAGE_TAG}, service "api" with a
#           healthcheck), .env.example, smoke.sh (reads BASE_URL and API_KEY),
#           host/egress-firewall.sh (`apply` | `check`), host/media-egress-firewall.service
#           (runs /usr/local/sbin/media-egress-firewall apply), and models.sh, which owns the model
#           list: `models.sh env NAME...` prints the FFMPEG_WHISPER_* lines for .env and
#           `models.sh sync ENV_FILE` downloads and verifies every model that ENV_FILE references.

# Where ci.yml pushes the image: ghcr.io/<repository owner>/media-service.
readonly DEFAULT_IMAGE="ghcr.io/bytebunch/media-service"

readonly APP_UID=10001                         # containers run as this UID (SPEC §17)
readonly API_HEALTH_TIMEOUT_SECONDS=180
readonly LOG_FILE=/var/log/media-install.log
readonly FIREWALL_BIN=/usr/local/sbin/media-egress-firewall
readonly FIREWALL_UNIT=media-egress-firewall.service
readonly FIRST_RUN_ONLY_SETTINGS=(MEDIA_FILES_PATH HTTP_PORT HTTP_BIND PUBLIC_BASE_URL MODELS
  DATABASE_URL DATABASE_MIGRATION_URL DATABASE_SSL_MODE DATABASE_SSL_CA_FILE)
readonly DATABASE_CA_IN_CONTAINER=/certs/database-ca.pem   # ./certs is mounted at /certs
readonly DOCKER_DAEMON_JSON='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "ipv6": false,
  "live-restore": true,
  "dns": ["1.1.1.1", "9.9.9.9"]
}'

# ---------------------------------------------------------------------------------------------
# Output. Before start_logging, messages go to the terminal only. After it, command output goes
# to $LOG_FILE and these messages go to both the terminal and the log.

emit() {  # <terminal fd> <message>
  printf '%s\n' "$2" >&"$1"
  if [[ -n ${TERM_OUT:-} ]]; then printf '%s\n' "$2" >&2; fi
}
log()  { emit "${TERM_OUT:-1}" "==> $*"; }
warn() { emit "${TERM_ERR:-2}" "WARNING: $*"; }
die()  { emit "${TERM_ERR:-2}" "ERROR: $*"; exit 1; }

start_logging() {
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  exec {TERM_OUT}>&1 {TERM_ERR}>&2
  exec >>"$LOG_FILE" 2>&1
  printf '\n----- install.sh started %s\n' "$(date -u +%FT%TZ)"
}

on_error() {  # <line number>
  emit "${TERM_ERR:-2}" "ERROR: install.sh failed at line $1. Last lines of $LOG_FILE:"
  tail -n 15 "$LOG_FILE" >&"${TERM_ERR:-2}"
  exit 1
}

cleanup() {
  if [[ -n ${BUNDLE_CONTAINER:-} ]]; then
    docker rm -f "$BUNDLE_CONTAINER" >/dev/null 2>&1 || warn "Could not remove container $BUNDLE_CONTAINER."
  fi
  if [[ -n ${BUNDLE_DIR:-} ]]; then rm -rf "$BUNDLE_DIR"; fi
}

# ---------------------------------------------------------------------------------------------
# Settings

apply_settings() {
  MEDIA_VERSION=${MEDIA_VERSION:-main}
  GH_TOKEN=${GH_TOKEN:-}
  if (( FIRST_RUN )); then
    MEDIA_IMAGE=${MEDIA_IMAGE:-$DEFAULT_IMAGE}
    MEDIA_FILES_PATH=${MEDIA_FILES_PATH:-$MEDIA_DIR/files}
    HTTP_PORT=${HTTP_PORT:-8085}
    HTTP_BIND=${HTTP_BIND:-127.0.0.1}
    PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}
    MODELS=${MODELS:-all}
    DATABASE_URL=${DATABASE_URL:-}
    DATABASE_MIGRATION_URL=${DATABASE_MIGRATION_URL:-}
    DATABASE_SSL_MODE=${DATABASE_SSL_MODE:-}
    DATABASE_SSL_CA_FILE=${DATABASE_SSL_CA_FILE:-}
    return 0
  fi
  warn_first_run_only_settings
  # the database settings live in .env from now on
  DATABASE_URL='' DATABASE_MIGRATION_URL='' DATABASE_SSL_MODE='' DATABASE_SSL_CA_FILE=''
  MEDIA_IMAGE=${MEDIA_IMAGE:-$(env_value MEDIA_IMAGE "$DEFAULT_IMAGE")}
  MEDIA_FILES_PATH=$(env_value MEDIA_FILES_PATH "$MEDIA_DIR/files")
  HTTP_PORT=$(env_value HTTP_PORT 8085)
  HTTP_BIND=$(env_value HTTP_BIND 127.0.0.1)
  PUBLIC_BASE_URL=$(env_value PUBLIC_BASE_URL "")
  MODELS=all   # unused on updates: the model choice already lives in .env
}

warn_first_run_only_settings() {
  local name
  for name in "${FIRST_RUN_ONLY_SETTINGS[@]}"; do
    if [[ -n ${!name:-} ]]; then
      warn "$name is only used on the first install and was ignored; change it in $ENV_FILE."
    fi
  done
}

env_value() {  # <key> <default>: the value in $ENV_FILE, or the default when it is not set there
  get_env_var "$ENV_FILE" "$1" || printf '%s\n' "$2"
}

validate_settings() {
  [[ $MEDIA_IMAGE =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+$ ]] \
    || die "MEDIA_IMAGE '$MEDIA_IMAGE' is not an image repository such as ghcr.io/acme/media-service."
  [[ $MEDIA_VERSION =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] \
    || die "MEDIA_VERSION '$MEDIA_VERSION' is not a valid image tag."
  is_absolute_path "$MEDIA_DIR" \
    || die "MEDIA_DIR must be an absolute path without spaces, not '$MEDIA_DIR'."
  is_absolute_path "$MEDIA_FILES_PATH" \
    || die "MEDIA_FILES_PATH must be an absolute path without spaces, not '$MEDIA_FILES_PATH'."
  is_port "$HTTP_PORT" || die "HTTP_PORT must be a port number (1-65535), not '$HTTP_PORT'."
  is_ipv4 "$HTTP_BIND" || die "HTTP_BIND must be an IPv4 address such as 0.0.0.0 or 127.0.0.1, not '$HTTP_BIND'."
  [[ $MODELS =~ ^(all|fast|none)$ ]] || die "MODELS must be all, fast or none, not '$MODELS'."
  [[ -z $PUBLIC_BASE_URL || $PUBLIC_BASE_URL =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] \
    || die "PUBLIC_BASE_URL must look like https://dl.example.com (no path), not '$PUBLIC_BASE_URL'."
  validate_database_settings
}

# The URLs hold a password, so messages never repeat them.
validate_database_settings() {
  local name
  if [[ -z ${DATABASE_URL:-} ]]; then
    for name in DATABASE_MIGRATION_URL DATABASE_SSL_MODE DATABASE_SSL_CA_FILE; do
      [[ -z ${!name:-} ]] || die "$name is only used with an outside DATABASE_URL."
    done
    return 0
  fi
  is_postgres_url "$DATABASE_URL" \
    || die "DATABASE_URL must be a postgres:// URL such as postgres://user:password@db.example.com:5432/media (not shown here: it holds a password)."
  [[ -z $DATABASE_MIGRATION_URL ]] || is_postgres_url "$DATABASE_MIGRATION_URL" \
    || die "DATABASE_MIGRATION_URL must be a postgres:// URL like DATABASE_URL."
  [[ -z $DATABASE_SSL_MODE || $DATABASE_SSL_MODE =~ ^(disable|require|verify-ca|verify-full)$ ]] \
    || die "DATABASE_SSL_MODE must be disable, require, verify-ca or verify-full, not '$DATABASE_SSL_MODE'."
  [[ -z $DATABASE_SSL_CA_FILE || ( -f $DATABASE_SSL_CA_FILE && -r $DATABASE_SSL_CA_FILE ) ]] \
    || die "DATABASE_SSL_CA_FILE '$DATABASE_SSL_CA_FILE' is not a readable file."
}

is_postgres_url() { [[ $1 =~ ^postgres(ql)?://[^[:space:]]+$ && -n $(database_host "$1") ]]; }

database_host() {  # <postgres URL>: its host, without user, password, port or database name
  [[ $1 =~ ^postgres(ql)?://([^@/]*@)?(\[[0-9A-Fa-f:.]+\]|[^/:?@]+) ]] && printf '%s\n' "${BASH_REMATCH[3]}"
}

is_absolute_path() { [[ $1 =~ ^/[A-Za-z0-9._/-]+$ && $1 != *..* ]]; }

is_port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }

is_ipv4() {
  local IFS=. octet
  local -a octets
  [[ $1 =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  read -ra octets <<<"$1"
  for octet in "${octets[@]}"; do (( 10#$octet <= 255 )) || return 1; done
}

is_private_ipv4() { [[ $1 =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; }

# ---------------------------------------------------------------------------------------------
# Server checks

read_os_release() {
  # shellcheck disable=SC1091
  { read -r OS_ID; read -r OS_VERSION; read -r OS_CODENAME; } < <(
    . /etc/os-release && printf '%s\n' "${ID:-}" "${VERSION_ID:-}" "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
}

check_os() {  # <os id> <version id> <dpkg architecture>
  local major=${2%%.*}
  case $1 in
    ubuntu) (( major >= 24 )) || die "Ubuntu $2 is not supported: use 24.04 or newer." ;;
    debian) (( major >= 13 )) || die "Debian $2 is not supported: use 13 or newer." ;;
    *) die "'$1' is not supported: use Ubuntu 24.04+ or Debian 13+." ;;
  esac
  [[ $3 == amd64 ]] || die "CPU architecture '$3' is not supported: the images are built for amd64."
}

# Prints yes or no: transcription (whisper.cpp) needs AVX2 on amd64 (DEPLOY.md §2b).
cpu_has_avx2() {
  if grep -qw avx2 /proc/cpuinfo; then echo yes; else echo no; fi
}

# The install goes ahead on any server; only transcription depends on the CPU.
check_cpu() {
  if [[ $(cpu_has_avx2) == no ]]; then
    warn "the CPU has no AVX2, so transcription is turned off."
    MODELS=none
  fi
}

# ---------------------------------------------------------------------------------------------
# System setup

apt_get() { DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 -y -qq "$@"; }

install_base_packages() {
  local cmd
  local -a missing=()
  for cmd in curl openssl ip ss; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
  if (( ${#missing[@]} == 0 )); then return 0; fi
  log "Installing base packages"
  apt_get update
  apt_get install ca-certificates curl openssl iproute2
}

install_docker() {
  if docker compose version >/dev/null 2>&1; then return 0; fi
  log "Installing Docker Engine from Docker's apt repository"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$OS_ID" "$OS_CODENAME" >/etc/apt/sources.list.d/docker.list
  apt_get update
  apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

# Never overwrites an existing daemon.json: the server may already run other containers.
configure_docker_daemon() {
  local file=/etc/docker/daemon.json
  if [[ -f $file ]]; then
    if [[ $(<"$file") != "$DOCKER_DAEMON_JSON" ]]; then
      warn "Keeping the existing $file. Recommended settings: DEPLOY.md §4.2."
    fi
    return 0
  fi
  log "Configuring Docker: bounded logs, IPv6 off, public DNS"
  mkdir -p /etc/docker
  printf '%s\n' "$DOCKER_DAEMON_JSON" >"$file"
  systemctl restart docker
}

require_docker_user_chain() {
  iptables -n -L DOCKER-USER >/dev/null 2>&1 \
    || die "Docker's DOCKER-USER firewall chain is missing, so the egress filter cannot be applied. Docker must use its default iptables firewall backend."
}

install_egress_firewall() {
  log "Installing the egress firewall"
  install -m 0755 "$MEDIA_DIR/host/egress-firewall.sh" "$FIREWALL_BIN"
  install -m 0644 "$MEDIA_DIR/host/$FIREWALL_UNIT" "/etc/systemd/system/$FIREWALL_UNIT"
  systemctl daemon-reload
  systemctl enable "$FIREWALL_UNIT"
  systemctl restart "$FIREWALL_UNIT"
  "$FIREWALL_BIN" check \
    || die "The egress firewall rules are not active. Details: journalctl -u $FIREWALL_UNIT"
}

create_dirs() {
  mkdir -p "$MEDIA_DIR/inbox" "$MEDIA_DIR/models" "$MEDIA_DIR/backups" "$MEDIA_DIR/certs" "$MEDIA_FILES_PATH"
  chown "$APP_UID:$APP_UID" "$MEDIA_FILES_PATH" "$MEDIA_DIR/backups"
  chmod 755 "$MEDIA_DIR" "$MEDIA_DIR/inbox" "$MEDIA_DIR/models" "$MEDIA_DIR/backups" "$MEDIA_DIR/certs" "$MEDIA_FILES_PATH"
}

install_database_ca() {  # the containers read it from the read-only /certs mount
  install -m 0644 "$DATABASE_SSL_CA_FILE" "$MEDIA_DIR/certs/database-ca.pem"
}

# ---------------------------------------------------------------------------------------------
# Release

registry_login() {
  if [[ -z $GH_TOKEN ]]; then return 0; fi
  local registry=${MEDIA_IMAGE%%/*} user
  user=$(github_login "$GH_TOKEN") || die "GitHub rejected GH_TOKEN."
  [[ -n $user ]] || die "GitHub rejected GH_TOKEN."
  log "Logging in to $registry as $user"
  docker login "$registry" --username "$user" --password-stdin <<<"$GH_TOKEN" >/dev/null
}

# The token goes to curl on stdin, so it never appears in the process list.
github_login() {  # <token>
  curl -fsS -H @- https://api.github.com/user <<<"Authorization: token $1" \
    | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p' | head -n 1
}

pull_image() {
  local ref="$MEDIA_IMAGE:$MEDIA_VERSION"
  log "Pulling $ref (this can take a few minutes)"
  docker pull "$ref" || die "Could not pull $ref. Private images need GH_TOKEN (DEPLOY-QUICKSTART.md)."
  RELEASE=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$ref")
  [[ $RELEASE =~ ^[0-9a-f]{7,40}$ ]] || die "$ref has no git revision label (org.opencontainers.image.revision)."
  docker tag "$ref" "$MEDIA_IMAGE:$RELEASE"
}

extract_bundle() {
  log "Installing the deployment files of $RELEASE into $MEDIA_DIR"
  BUNDLE_DIR=$(mktemp -d)
  BUNDLE_CONTAINER=$(docker create "$MEDIA_IMAGE:$RELEASE")
  docker cp "$BUNDLE_CONTAINER:/app/deploy/." "$BUNDLE_DIR"
  docker rm "$BUNDLE_CONTAINER" >/dev/null
  BUNDLE_CONTAINER=""
  install_bundle "$BUNDLE_DIR" "$MEDIA_DIR"
}

# Bundle files are replaced on every run; local changes belong in docker-compose.override.yml,
# which the bundle never ships. Each file is renamed into place, so a running copy of this script
# is never overwritten. .env is never shipped or touched.
install_bundle() {  # <source dir> <install dir>
  local src=$1 dest=$2 rel mode
  [[ -f $src/docker-compose.yml && -f $src/.env.example ]] \
    || die "The image has no deployment bundle at /app/deploy."
  while IFS= read -r -d '' rel; do
    case $rel in ./.env | ./docker-compose.override.yml) continue ;; esac
    if [[ $rel == *.sh ]]; then mode=0755; else mode=0644; fi
    install -D -m "$mode" "$src/$rel" "$dest/$rel.new"
    mv -f "$dest/$rel.new" "$dest/$rel"
  done < <(cd "$src" && find . -type f -print0)
}

record_release() {  # <history file> <release>
  local last=""
  if [[ -f $1 ]]; then last=$(tail -n 1 "$1"); fi
  [[ $last == "$2" ]] || printf '%s\n' "$2" >>"$1"
}

# ---------------------------------------------------------------------------------------------
# Configuration (.env)

set_env_var() {  # <file> <key> <value>: replaces the first assignment of key, or appends one
  local file=$1 key=$2 value=$3 line tmp found=0
  tmp=$(mktemp "$file.XXXXXX")
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line != "$key="* ]]; then
      printf '%s\n' "$line"
    elif (( !found )); then
      printf '%s=%s\n' "$key" "$value"
      found=1
    fi
  done <"$file" >"$tmp"
  if (( !found )); then printf '%s=%s\n' "$key" "$value" >>"$tmp"; fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

set_env_vars() {  # <file> KEY VALUE [KEY VALUE ...]
  local file=$1
  shift
  while (( $# >= 2 )); do
    set_env_var "$file" "$1" "$2"
    shift 2
  done
}

get_env_var() {  # <file> <key>: prints the value; fails when the key is not set
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$2="* ]]; then
      printf '%s\n' "${line#*=}"
      return 0
    fi
  done <"$1"
  return 1
}

model_names() {  # <all|fast|none>
  case $1 in
    all) echo "fast balanced accurate" ;;
    fast) echo "fast" ;;
    none) echo "" ;;
  esac
}

default_public_url() {  # <bind address> <server IP> <port>
  local host=$2
  if [[ $1 != 0.0.0.0 ]]; then host=$1; fi
  if [[ $3 == 80 ]]; then printf 'http://%s\n' "$host"; else printf 'http://%s:%s\n' "$host" "$3"; fi
}

detect_ipv4() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }'
}

public_base_url() {
  local ip
  if [[ -n $PUBLIC_BASE_URL ]]; then
    printf '%s\n' "$PUBLIC_BASE_URL"
    return 0
  fi
  # Bound to one address (the default 127.0.0.1): links use it, the server's own IP does not matter.
  if [[ $HTTP_BIND != 0.0.0.0 ]]; then
    default_public_url "$HTTP_BIND" "" "$HTTP_PORT"
    return 0
  fi
  ip=$(detect_ipv4)
  if [[ -z $ip ]]; then
    ip=127.0.0.1
    warn "Could not detect this server's IP address; set PUBLIC_BASE_URL in $ENV_FILE."
  elif is_private_ipv4 "$ip"; then
    warn "This server's address $ip is private (NAT); set PUBLIC_BASE_URL in $ENV_FILE to the public address."
  fi
  default_public_url "$HTTP_BIND" "$ip" "$HTTP_PORT"
}

write_initial_env() {
  local public_url pg_password link_secret encryption_key whisper line
  local profiles=local-db,local-redis,proxy database_url
  local -a names
  log "Writing $ENV_FILE with generated secrets"
  public_url=$(public_base_url)
  pg_password=$(openssl rand -hex 24)              # hex: it goes inside DATABASE_URL
  link_secret=$(openssl rand -base64 32)
  encryption_key=$(openssl rand -base64 32)
  database_url="postgres://ytdlp_app:$pg_password@postgres:5432/media"
  if [[ -n $DATABASE_URL ]]; then
    profiles=local-redis,proxy
    database_url=$DATABASE_URL
  fi
  read -ra names <<<"$(model_names "$MODELS")"
  whisper=$("$MEDIA_DIR/models.sh" env "${names[@]}")

  install -m 0600 "$MEDIA_DIR/.env.example" "$ENV_FILE"
  set_env_vars "$ENV_FILE" \
    COMPOSE_PROJECT_NAME media \
    COMPOSE_PROFILES "$profiles" \
    MEDIA_FILES_PATH "$MEDIA_FILES_PATH" \
    HTTP_PORT "$HTTP_PORT" \
    HTTP_BIND "$HTTP_BIND" \
    PUBLIC_BASE_URL "$public_url" \
    POSTGRES_USER ytdlp_app \
    POSTGRES_DB media \
    POSTGRES_PASSWORD "$pg_password" \
    DATABASE_URL "$database_url" \
    REDIS_URL redis://redis:6379 \
    LINK_SIGNING_SECRET "$link_secret" \
    TOKEN_ENCRYPTION_KEYS "v1:$encryption_key"
  while IFS= read -r line; do
    if [[ -n $line ]]; then set_env_var "$ENV_FILE" "${line%%=*}" "${line#*=}"; fi
  done <<<"$whisper"
  if [[ -n $DATABASE_URL ]]; then write_database_env; fi
}

# An outside database keeps the generated POSTGRES_* values too: compose resolves the bundled
# postgres service's variables even when its profile is off, and fails without them.
write_database_env() {
  set_env_var "$ENV_FILE" DATABASE_SSL_MODE "${DATABASE_SSL_MODE:-verify-full}"
  if [[ -n $DATABASE_MIGRATION_URL ]]; then
    set_env_var "$ENV_FILE" DATABASE_MIGRATION_URL "$DATABASE_MIGRATION_URL"
  fi
  if [[ -n $DATABASE_SSL_CA_FILE ]]; then
    set_env_var "$ENV_FILE" DATABASE_SSL_CA_FILE "$DATABASE_CA_IN_CONTAINER"
  fi
}

prepare_models() {
  log "Downloading the whisper models listed in .env (about 1 GB on a first install)"
  "$MEDIA_DIR/models.sh" sync "$ENV_FILE"
}

# ---------------------------------------------------------------------------------------------
# Outside database

# Runs before the firewall and the model download, so a wrong DATABASE_URL fails in seconds. The
# one-off migrate container connects with the stack's own settings and applies the migrations;
# its last line names the cause when it cannot.
check_database() {
  local host output status=0
  host=$(outside_database_host) || return 0
  log "Checking the database at $host (and applying migrations)"
  output=$(compose run --rm --no-deps migrate 2>&1) || status=$?
  printf '%s\n' "$output"
  if (( status == 0 )); then return 0; fi
  die "The database at $host did not answer: $(awk 'NF { line = $0 } END { print line }' <<<"$output")
     Check DATABASE_URL and DATABASE_SSL_* in $ENV_FILE, then run the installer again. Supabase: use the pooler's session address (port 5432); its CA certificate goes in $MEDIA_DIR/certs/database-ca.pem with DATABASE_SSL_CA_FILE=$DATABASE_CA_IN_CONTAINER."
}

outside_database_host() {  # the host of DATABASE_URL in .env, unless it is the bundled postgres
  local host
  host=$(database_host "$(env_value DATABASE_URL "")") || return 1
  [[ $host != postgres ]] && printf '%s\n' "$host"
}

# ---------------------------------------------------------------------------------------------
# Ports

# Runs before the firewall and the model download, so a taken port fails in seconds and names
# the setting to change. The API is published on localhost, the bundled proxy on HTTP_BIND.
check_ports() {
  local api_port
  api_port=$(env_value API_PORT 3000)
  is_port "$api_port" || die "API_PORT in $ENV_FILE must be a port number (1-65535), not '$api_port'."
  require_free_port 127.0.0.1 "$api_port" API_PORT
  if [[ ,$(env_value COMPOSE_PROFILES ""), == *,proxy,* ]]; then
    require_free_port "$HTTP_BIND" "$HTTP_PORT" HTTP_PORT
  fi
}

require_free_port() {  # <bind address> <port> <.env key>
  local project users
  # On updates the stack's own containers hold its ports; compose recreates them.
  project=$(env_value COMPOSE_PROJECT_NAME media)
  if [[ -n $(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "publish=$2") ]]; then
    return 0
  fi
  users=$(port_users "$1" "$2")
  if [[ -n $users ]]; then
    die "Port $1:$2 ($3) is already in use by $users. Set $3 in $ENV_FILE to a free port, then run the installer again."
  fi
}

port_users() {  # <bind address> <port>: who listens where binding there would fail, or nothing
  local address process user list=""
  while read -r address process; do
    port_conflicts "$1" "$address" || continue
    user=$(sed -n 's/^users:(("\([^"]*\)".*/\1/p' <<<"$process")
    if [[ $user == docker-proxy ]]; then
      user="container $(docker ps --filter "publish=$2" --format '{{.Names}}' | paste -sd, -)"
    fi
    user=${user:-another program}
    if [[ ", $list, " != *", $user, "* ]]; then list+=${list:+, }$user; fi
  done < <(ss -Hltnp "sport = :$2" | awk '{ a = $4; sub(/:[0-9]+$/, "", a); sub(/%.*$/, "", a); print a, (NF >= 6 ? $6 : "") }')
  if [[ -n $list ]]; then printf '%s\n' "$list"; fi
}

# Linux refuses the bind when the listener has the same address or a wildcard one ("*" is a
# dual-stack socket; "[::]" is IPv6-only and does not collide), and 0.0.0.0 collides with every
# IPv4 listener.
port_conflicts() {  # <IPv4 bind address> <listener address as ss prints it, without the port>
  case $2 in 0.0.0.0 | '*' | "$1") return 0 ;; esac
  [[ $1 == 0.0.0.0 && $2 != \[* ]]
}

# ---------------------------------------------------------------------------------------------
# Stack

compose() { (cd "$MEDIA_DIR" && docker compose "$@"); }

api_cli() { compose exec -T api cli "$@"; }

# Compose ends its output with the error, such as "Bind for 127.0.0.1:3000 failed: port is already
# allocated"; the terminal gets that line, the log gets everything.
start_stack() {
  local output status=0
  log "Starting the services (database migrations run first)"
  output=$(compose up -d --pull missing --remove-orphans 2>&1) || status=$?
  printf '%s\n' "$output"
  if (( status == 0 )); then return 0; fi
  die "The services did not start: $(awk 'NF { line = $0 } END { print line }' <<<"$output")
       Details: $LOG_FILE; per service: cd $MEDIA_DIR && docker compose ps -a, then docker compose logs <service>"
}

wait_for_api() {
  local deadline=$((SECONDS + API_HEALTH_TIMEOUT_SECONDS)) status container
  log "Waiting for the API to become healthy"
  while (( SECONDS < deadline )); do
    container=$(compose ps -q api)
    status=""
    if [[ -n $container ]]; then
      status=$(docker inspect --format '{{ if .State.Health }}{{ .State.Health.Status }}{{ end }}' "$container")
    fi
    if [[ $status == healthy ]]; then return 0; fi
    sleep 3
  done
  die "The API was not healthy after ${API_HEALTH_TIMEOUT_SECONDS}s. Details: cd $MEDIA_DIR && docker compose logs api"
}

create_api_key() {  # <client name>
  local key
  key=$(api_cli keys:create "$1" --quiet) || die "Could not create an API key for '$1'."
  [[ $key =~ ^[A-Za-z0-9_-]{20,}$ ]] || die "keys:create returned an unexpected value."
  printf '%s\n' "$key"
}

revoke_api_key() {  # <key>
  api_cli keys:revoke --key "$1" >/dev/null \
    || warn "Could not revoke the smoke-test API key; list keys with: docker compose exec api cli keys:list"
}

# Uses a throwaway key so the check runs the same way on first installs and updates.
run_smoke_test() {
  local key host=$HTTP_BIND
  if [[ $host == 0.0.0.0 ]]; then host=127.0.0.1; fi
  key=$(create_api_key installer-smoke) || exit 1
  log "Running the smoke test"
  if BASE_URL="http://$host:$HTTP_PORT" API_KEY="$key" "$MEDIA_DIR/smoke.sh"; then
    revoke_api_key "$key"
    return 0
  fi
  revoke_api_key "$key"
  if [[ -s $HISTORY_FILE ]]; then
    die "The smoke test failed (details in $LOG_FILE). Roll back with: cd $MEDIA_DIR && sudo ./deploy.sh $(tail -n 1 "$HISTORY_FILE")"
  fi
  die "The smoke test failed. Details: $LOG_FILE"
}

print_summary() {  # <new API key, empty on updates>
  local base
  base=$(get_env_var "$ENV_FILE" PUBLIC_BASE_URL)
  log "Done"
  {
    printf '\nMedia Service %s is running\n\n' "$RELEASE"
    printf '  API      %s/v1\n  Docs     %s/docs\n  MCP      %s/mcp\n' "$base" "$base" "$base"
    if [[ -n $1 ]]; then printf '  API key  %s   <- shown once, store it now\n' "$1"; fi
    printf '\n  Config   %s   <- back this file up: it holds the encryption key\n' "$ENV_FILE"
    # Behind the developer's own nginx, HTTP_BIND stays local but the links point at it.
    if [[ $HTTP_BIND == 127.* && $base =~ ^http://(127\.|localhost[:/]|localhost$) ]]; then
      printf '  Access   this server only (HTTP_BIND=%s). To open it to other machines, either\n' "$HTTP_BIND"
      printf '           - set HTTP_BIND=0.0.0.0 and PUBLIC_BASE_URL in %s, then docker compose up -d, or\n' "$ENV_FILE"
      printf '           - put your nginx in front (%s/nginx/front.conf) and set PUBLIC_BASE_URL to its address.\n' "$MEDIA_DIR"
      printf '           DEPLOY-QUICKSTART.md, "Opening it up"\n'
    elif [[ $base == http://* ]]; then
      printf '  Warning  plain HTTP on %s: add TLS before real use (DEPLOY-QUICKSTART.md, "Later: nginx and TLS")\n' "$HTTP_BIND"
    fi
    printf '  Log      %s\n\n' "$LOG_FILE"
  } >&"$TERM_OUT"
}

# ---------------------------------------------------------------------------------------------

main() {
  exec </dev/null   # when piped from curl, nothing below may read the rest of the script
  if (( EUID != 0 )); then
    echo "Run as root, e.g.: curl -fsSL <install.sh URL> | sudo bash" >&2
    exit 1
  fi
  umask 022
  start_logging
  trap 'on_error $LINENO' ERR
  trap cleanup EXIT

  MEDIA_DIR=${MEDIA_DIR:-/srv/media}
  ENV_FILE=$MEDIA_DIR/.env
  HISTORY_FILE=$MEDIA_DIR/.release-history
  FIRST_RUN=1
  if [[ -f $ENV_FILE ]]; then FIRST_RUN=0; fi
  apply_settings
  validate_settings

  log "Checking the server"
  read_os_release
  check_os "$OS_ID" "$OS_VERSION" "$(dpkg --print-architecture)"
  check_cpu

  install_base_packages
  install_docker
  configure_docker_daemon
  require_docker_user_chain

  registry_login
  pull_image
  extract_bundle
  create_dirs
  if (( FIRST_RUN )) && [[ -n $DATABASE_SSL_CA_FILE ]]; then install_database_ca; fi
  if (( FIRST_RUN )); then write_initial_env; fi
  set_env_vars "$ENV_FILE" MEDIA_IMAGE "$MEDIA_IMAGE" IMAGE_TAG "$RELEASE"

  check_ports
  check_database
  install_egress_firewall
  prepare_models
  start_stack
  wait_for_api
  run_smoke_test

  # The first key is created once the first install has fully succeeded, even if an earlier
  # attempt failed after writing .env.
  local api_key=""
  if [[ ! -s $HISTORY_FILE ]]; then
    api_key=$(create_api_key default) || exit 1
    log "Created the first API key (client 'default')"
  fi
  record_release "$HISTORY_FILE" "$RELEASE"
  print_summary "$api_key"
}

# Bash parses this whole block before running it, so replacing this file on disk mid-run
# (extract_bundle does) cannot change what executes. Tests source the file with
# MEDIA_INSTALL_SOURCED=1 to call functions one by one.
if [[ ${MEDIA_INSTALL_SOURCED:-0} != 1 ]]; then
  set -Eeuo pipefail
  main "$@"
  exit
fi
