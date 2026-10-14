#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
directory=$(cd -- "$(dirname -- "$0")" && pwd)
mode=${1:?Usage: setup-osiris.sh prepare|cutover PUBLIC_KEY_FILE}
home=/var/lib/athena
as_user() {
  local name=$1 uid
  shift
  uid=$(id -u "$name")
  runuser -u "$name" -- env XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}
if [[ "$mode" = prepare ]]; then
  key=${2:?Public key file is required}
  python3 - "$key" <<'PY'
import pathlib,re,sys
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^\r\n]*)?',pathlib.Path(sys.argv[1]).read_text().strip()):
    raise SystemExit('Expected one Ed25519 public key')
PY
  ss -lnt | grep -q '100.65.83.93:2222'
  id athena >/dev/null 2>&1 || useradd --create-home --home-dir "$home" --shell /bin/bash athena
  test "$(getent passwd athena | cut -d: -f6)" = "$home"
  test "$(id -u athena)" != 0
  test "$(id -Gn athena)" = athena
  install -d -m 700 -o athena -g athena "$home/releases"
  install -m 755 "$directory/receive.py" /usr/local/libexec/athena-receive
  install -m 644 "$directory/athena.service" /etc/systemd/user/athena.service
  { printf 'restrict,command="/usr/local/libexec/athena-receive" '; cat "$key"; printf '\n'; } > /etc/ssh/authorized_keys/athena
  chmod 644 /etc/ssh/authorized_keys/athena
  config=/etc/ssh/sshd_config.d/50-athena-deploy.conf
  test ! -e "$config" || cp -a "$config" "$config.previous"
  cat > "$config" <<'CONFIG'
Match User athena
    AuthorizedKeysFile /etc/ssh/authorized_keys/athena
    ForceCommand /usr/local/libexec/athena-receive
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
Match all
CONFIG
  if ! /usr/sbin/sshd -t; then
    if [[ -e "$config.previous" ]]; then mv "$config.previous" "$config"; else rm "$config"; fi
    exit 1
  fi
  systemctl reload sshd
  loginctl enable-linger athena
  systemctl start "user@$(id -u athena).service"
  as_user athena systemctl --user daemon-reload
  echo 'Prepared Athena. The existing autorole service is still running.'
elif [[ "$mode" = cutover ]]; then
  test ! -e "$home/ready"
  python3 - /usr/local/libexec/athena-receive <<'PY'
import runpy,sys
assert callable(runpy.run_path(sys.argv[1]).get('activate'))
PY
  exec 9>"$home/migration.lock"
  flock -n 9
  # Exercise the notification helper inside the installed sandbox before stopping legacy.
  as_user athena /usr/bin/bash -s -- /etc/systemd/user/athena.service < "$directory/check-readiness.sh"
  initial="$home/releases/initial-$(date +%s)"
  install -m 700 -o athena -g athena /home/chrono/.local/share/autorole/autorole "$initial"
  install -m 640 -o root -g athena /home/chrono/.config/autorole/env "$home/runtime.env"
  ln -sfn "$initial" "$home/current"
  chown -h athena:athena "$home/current"
  as_user chrono systemctl --user stop autorole.service
  rollback() {
    local status=$?
    trap - EXIT
    if (( status != 0 )); then
      if as_user athena systemctl --user stop athena.service; then
        as_user athena systemctl --user disable athena.service || true
        as_user chrono systemctl --user enable --now autorole.service
        echo 'Cutover failed; resumed the existing autorole service.' >&2
      else
        echo 'Replacement did not stop; legacy autorole was not restarted.' >&2
      fi
    fi
    exit "$status"
  }
  trap rollback EXIT
  as_user athena systemctl --user enable --now athena.service
  as_user athena systemctl --user is-active athena.service
  as_user chrono systemctl --user disable autorole.service
  install -m 644 /dev/null "$home/ready"
  trap - EXIT
  echo 'Athena is connected to Discord under its dedicated account.'
else
  exit 2
fi
