#!/usr/bin/env bash
# Egress filter for the containers that fetch caller-supplied URLs (DEPLOY.md §4.5), installed as
# /usr/local/sbin/media-egress-firewall and run by media-egress-firewall.service after Docker.
#   media-egress-firewall apply    (re)creates the rules; safe to run any number of times
#   media-egress-firewall check    exits 0 when every rule is in place
#   media-egress-firewall remove   takes them out again
# Settings (environment, or /etc/default/media-egress-firewall through the unit):
#   EGRESS_SUBNET   the egress network's subnet in docker-compose.yml     default 172.30.0.0/24
#   EGRESS_BRIDGE   its bridge interface                                   default br-media-egress
#   EGRESS_ALLOW    space-separated CIDR[:port] destinations that stay reachable although they are
#                   private, e.g. an external Postgres on a private network: "10.0.0.5/32:5432"
set -euo pipefail

readonly CHAIN=MEDIA-EGRESS            # jumped to from DOCKER-USER for the egress subnet
readonly HOST_CHAIN=MEDIA-EGRESS-HOST  # jumped to from INPUT for the egress bridge
readonly SUBNET=${EGRESS_SUBNET:-172.30.0.0/24}
readonly BRIDGE=${EGRESS_BRIDGE:-br-media-egress}
read -ra ALLOW <<<"${EGRESS_ALLOW:-}"
# Private, CGNAT, link-local (cloud metadata), multicast, "this network" and reserved ranges.
readonly BLOCKED=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 224.0.0.0/4 0.0.0.0/8 240.0.0.0/4)

die() { echo "media-egress-firewall: $*" >&2; exit 1; }

ensure_chain() { iptables -n -L "$1" >/dev/null 2>&1 || iptables -N "$1"; }

# Inserts the jump once, at the top, so it runs before Docker's own rules.
ensure_jump() {  # <parent chain> <match...> -- the jump target is the last argument
  local parent=$1
  shift
  iptables -C "$parent" "$@" 2>/dev/null || iptables -I "$parent" 1 "$@"
}

# EGRESS_ALLOW as iptables rules, one per line; checked in full before any rule changes, so a
# bad entry can never leave the filter half-built.
ALLOW_RULES=()
parse_allow() {
  local entry cidr port
  for entry in "${ALLOW[@]}"; do
    cidr=${entry%%:*}
    port=
    [[ $entry == *:* ]] && port=${entry##*:}
    [[ $cidr =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || die "EGRESS_ALLOW: '$entry' is not CIDR[:port]"
    if [ -n "$port" ]; then
      [[ $port =~ ^[0-9]{1,5}$ ]] || die "EGRESS_ALLOW: '$entry' has no valid port"
      ALLOW_RULES+=("-d $cidr -p tcp --dport $port -j RETURN")
    else
      ALLOW_RULES+=("-d $cidr -j RETURN")
    fi
  done
}

apply() {
  iptables -n -L DOCKER-USER >/dev/null 2>&1 \
    || die "the DOCKER-USER chain is missing: start Docker (iptables firewall backend) first"
  parse_allow
  ensure_chain "$CHAIN"
  iptables -F "$CHAIN"
  # Replies to connections already allowed (e.g. host nginx → api's published port) pass.
  iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  local rule
  for rule in "${ALLOW_RULES[@]}"; do
    # Word splitting is the point: each entry holds validated, space-free tokens.
    # shellcheck disable=SC2086
    iptables -A "$CHAIN" $rule
  done
  for range in "${BLOCKED[@]}"; do iptables -A "$CHAIN" -d "$range" -j DROP; done
  ensure_jump DOCKER-USER -s "$SUBNET" -j "$CHAIN"

  ensure_chain "$HOST_CHAIN"
  iptables -F "$HOST_CHAIN"
  # No new connections from the egress network to the host itself (sshd, nginx, the gateway).
  iptables -A "$HOST_CHAIN" -m conntrack --ctstate NEW -j DROP
  ensure_jump INPUT -i "$BRIDGE" -j "$HOST_CHAIN"
}

check() {
  iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || die "DOCKER-USER does not jump to $CHAIN"
  iptables -C INPUT -i "$BRIDGE" -j "$HOST_CHAIN" 2>/dev/null || die "INPUT does not jump to $HOST_CHAIN"
  for range in "${BLOCKED[@]}"; do
    iptables -C "$CHAIN" -d "$range" -j DROP 2>/dev/null || die "$range is not blocked"
  done
  iptables -C "$HOST_CHAIN" -m conntrack --ctstate NEW -j DROP 2>/dev/null || die "the host is reachable from the egress network"
  echo "media-egress-firewall: active for $SUBNET ($BRIDGE)"
}

remove() {
  while iptables -D DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null; do :; done
  while iptables -D INPUT -i "$BRIDGE" -j "$HOST_CHAIN" 2>/dev/null; do :; done
  for chain in "$CHAIN" "$HOST_CHAIN"; do
    if iptables -n -L "$chain" >/dev/null 2>&1; then
      iptables -F "$chain"
      iptables -X "$chain"
    fi
  done
}

case "${1:-}" in
  apply) apply ;;
  check) check ;;
  remove) remove ;;
  *) die "usage: media-egress-firewall apply | check | remove" ;;
esac
