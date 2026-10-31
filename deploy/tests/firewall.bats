#!/usr/bin/env bats
# host/egress-firewall.sh with real iptables and real packets: network namespaces stand in for a
# container on the egress bridge, a private LAN host, a public host and the host itself.
# Needs root and NET_ADMIN (deploy/tests/run.sh starts a privileged container).

FIREWALL=/deploy/host/egress-firewall.sh

setup_file() {
  sysctl -qw net.ipv4.ip_forward=1
  # Docker's chain, as Docker creates it.
  iptables -N DOCKER-USER
  iptables -I FORWARD -j DOCKER-USER
  iptables -A DOCKER-USER -j RETURN
  ip link add br-media-egress type bridge
  ip addr add 172.30.0.1/24 dev br-media-egress
  ip link set br-media-egress up
  # The "container" on the egress network.
  ip netns add ctr
  ip link add ctr-host type veth peer name ctr-ns
  ip link set ctr-ns netns ctr
  ip link set ctr-host master br-media-egress up
  ip -n ctr addr add 172.30.0.2/24 dev ctr-ns
  ip -n ctr link set ctr-ns up
  ip -n ctr route add default via 172.30.0.1
  # A private address and a public one, each in its own namespace.
  for spec in "lan 10.0.0.5 10.0.0.1" "pub 198.51.100.10 198.51.100.1"; do
    read -r name addr gateway <<<"$spec"
    ip netns add "$name"
    ip link add "$name-host" type veth peer name "$name-ns"
    ip link set "$name-ns" netns "$name"
    ip addr add "$gateway/24" dev "$name-host"
    ip link set "$name-host" up
    ip -n "$name" addr add "$addr/24" dev "$name-ns"
    ip -n "$name" link set "$name-ns" up
    ip -n "$name" route add default via "$gateway"
  done
  for port in 80 5432; do
    ip netns exec lan nc -lk 10.0.0.5 "$port" >/dev/null 2>&1 &
  done
  ip netns exec pub nc -lk 198.51.100.10 443 >/dev/null 2>&1 &
  nc -lk 172.30.0.1 22 >/dev/null 2>&1 &
  sleep 0.5
}

teardown_file() {
  "$FIREWALL" remove || true
  pkill nc || true
}

reachable() {  # <address> <port>: from the "container"
  ip netns exec ctr nc -z -w 2 "$1" "$2"
}

@test "without the filter every destination is reachable" {
  "$FIREWALL" remove
  reachable 10.0.0.5 80
  reachable 198.51.100.10 443
  reachable 172.30.0.1 22
}

@test "apply blocks private destinations and the host, and keeps the internet" {
  "$FIREWALL" apply
  run reachable 10.0.0.5 80
  [ "$status" -ne 0 ]
  run reachable 172.30.0.1 22
  [ "$status" -ne 0 ]
  reachable 198.51.100.10 443
  "$FIREWALL" check
}

@test "apply is idempotent" {
  "$FIREWALL" apply
  before=$(iptables -S | wc -l)
  "$FIREWALL" apply
  "$FIREWALL" apply
  [ "$(iptables -S | wc -l)" -eq "$before" ]
  [ "$(iptables -S DOCKER-USER | grep -c MEDIA-EGRESS)" -eq 1 ]
}

@test "EGRESS_ALLOW opens one private address and port, nothing more" {
  EGRESS_ALLOW="10.0.0.5/32:5432" "$FIREWALL" apply
  reachable 10.0.0.5 5432
  run reachable 10.0.0.5 80
  [ "$status" -ne 0 ]
  # A bad entry is refused before anything changes: the filter stays as it was.
  run env EGRESS_ALLOW="10.0.0.5/32:5432 not-a-cidr" "$FIREWALL" apply
  [ "$status" -ne 0 ]
  [[ $output == *"is not CIDR[:port]"* ]]
  "$FIREWALL" check
  reachable 10.0.0.5 5432
}

@test "check fails once the rules are gone, and remove leaves nothing behind" {
  "$FIREWALL" remove
  run "$FIREWALL" check
  [ "$status" -ne 0 ]
  [[ $output == *"does not jump"* ]]
  [ "$(iptables -S | grep -c MEDIA-EGRESS || true)" -eq 0 ]
}

@test "apply refuses to run without Docker's chain" {
  iptables -D FORWARD -j DOCKER-USER
  iptables -F DOCKER-USER
  iptables -X DOCKER-USER
  run "$FIREWALL" apply
  [ "$status" -ne 0 ]
  [[ $output == *"DOCKER-USER chain is missing"* ]]
}
