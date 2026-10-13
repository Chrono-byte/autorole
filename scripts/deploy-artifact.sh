#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
export DEPLOY_HOST=100.65.83.93 DEPLOY_USER=athena
export DEPLOY_HOST_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBMG5RLxl/lKd13mZC5UpdO6zH3K02v07QcP5SFxZ5+'
test -f dist/autorole
checksum=$(sha256sum dist/autorole | cut -d' ' -f1)
size=$(stat -c %s dist/autorole)
{ git rev-parse HEAD; printf '%s %s\n' "$checksum" "$size"; cat dist/autorole; } | bash deploy/tailscale-ssh.sh
