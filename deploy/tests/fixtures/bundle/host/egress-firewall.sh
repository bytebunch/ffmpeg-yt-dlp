#!/usr/bin/env bash
# Test double for the bundle's egress firewall script.
printf 'egress-firewall %s\n' "$*" >>"$CALLS_LOG"
