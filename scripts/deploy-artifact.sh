#!/bin/sh
set -eu
umask 077

cd "$(dirname "$0")/.."
deploy_host=${1:-chrono@hermes}
test -f dist/autorole

ssh -o BatchMode=yes -o ConnectTimeout=10 "$deploy_host" '
  set -eu
  command -v systemd-notify >/dev/null
  test -s .config/autorole/env
  umask 077
  mkdir -p .local/share/autorole .config/systemd/user
'
scp -C -o BatchMode=yes -o ConnectTimeout=10 dist/autorole "$deploy_host:.local/share/autorole/autorole.new"
scp -o BatchMode=yes -o ConnectTimeout=10 deploy/autorole.service "$deploy_host:.config/systemd/user/autorole.service.new"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$deploy_host" '
  set -eu
  chmod 700 .local/share/autorole/autorole.new
  chmod 600 .config/systemd/user/autorole.service.new
  mv .local/share/autorole/autorole.new .local/share/autorole/autorole
  mv .config/systemd/user/autorole.service.new .config/systemd/user/autorole.service
  systemctl --user daemon-reload
  systemctl --user enable autorole.service
  # Type=notify waits for the bot to connect to Discord before reporting success.
  systemctl --user restart autorole.service
  systemctl --user is-active autorole.service
'
