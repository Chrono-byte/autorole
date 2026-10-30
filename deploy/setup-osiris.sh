#!/usr/bin/env bash
set -euo pipefail
umask 077
test "$(id -u)" = 0
directory=$(cd -- "$(dirname -- "$0")" && pwd)
mode=${1:?Usage: setup-osiris.sh prepare PUBLIC_KEY_FILE}
[[ "$mode" = prepare ]] || { echo "Usage: setup-osiris.sh prepare PUBLIC_KEY_FILE" >&2; exit 2; }
home=/var/lib/athena
as_user() {
  local name=$1 uid
  shift
  uid=$(id -u "$name")
  runuser -u "$name" -- env XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
}
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
echo 'Prepared Athena deployment infrastructure.'
