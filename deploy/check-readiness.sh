#!/usr/bin/env bash
# Run as the service account; uses the actual unit's sandbox settings.
set -euo pipefail
unit=${1:-/etc/systemd/user/athena.service}
runtime=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
properties=()
while IFS='=' read -r name value; do
  case "$name" in
    NotifyAccess|NoNewPrivileges|PrivateTmp|ProtectSystem|ProtectHome|ReadOnlyPaths|BindReadOnlyPaths|RestrictSUIDSGID|LockPersonality|UMask|LimitCORE)
      properties+=(--property="$name=${value//%t/$runtime}")
      ;;
  esac
done < "$unit"
systemd-run --user --wait --collect --property=Type=notify \
  --property=TimeoutStartSec=10 "${properties[@]}" \
  /usr/bin/bash -ec '
    test -S "$NOTIFY_SOCKET"
    test -z "$(ls -A /home)"
    test -z "$(ls -A /root)"
    systemd-notify --ready --status="Readiness preflight passed"
  '
