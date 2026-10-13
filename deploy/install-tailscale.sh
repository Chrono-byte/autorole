#!/usr/bin/env bash
set -euo pipefail
test "$(uname -m)" = x86_64
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
curl --fail --silent --show-error --location \
  https://pkgs.tailscale.com/stable/tailscale_1.104.1_amd64.tgz -o "$work/tailscale.tgz"
printf '%s  %s\n' 108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528 "$work/tailscale.tgz" | sha256sum --check
tar -xzf "$work/tailscale.tgz" -C "$work"
install -m 755 "$work/tailscale_1.104.1_amd64/tailscale" /usr/local/bin/tailscale
install -m 755 "$work/tailscale_1.104.1_amd64/tailscaled" /usr/local/bin/tailscaled
