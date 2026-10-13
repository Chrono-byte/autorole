#!/usr/bin/env bash
set -euo pipefail
umask 077
host_pattern='^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
user_pattern='^[a-z][a-z0-9-]{0,31}$'
key_pattern='^ssh-ed25519 [A-Za-z0-9+/=]+$'
[[ "${DEPLOY_HOST:-}" =~ $host_pattern ]] || { echo 'Expected a tailnet IPv4 address' >&2; exit 2; }
[[ "${DEPLOY_USER:-}" =~ $user_pattern ]] || { echo 'Invalid deployment account' >&2; exit 2; }
[[ "${DEPLOY_HOST_KEY:-}" =~ $key_pattern ]] || { echo 'Expected one pinned Ed25519 host key' >&2; exit 2; }
case "${1:-deploy}" in deploy|verify) ;; *) echo 'Only deploy and verify are permitted' >&2; exit 2 ;; esac

# Canonical source: satet-infra/deploy/tailscale-ssh.sh. Vendored unchanged in app repositories.
# This client runs in a deployment job, never on the production host.
test -n "${TS_OAUTH_CLIENT_SECRET:?Set the tag:deploy OAuth secret}"
test -n "${DEPLOY_SSH_KEY:?Set the Guildmaster deployment key}"
command -v tailscaled >/dev/null
command -v ssh >/dev/null
work=$(mktemp -d /tmp/tailscale-deploy.XXXXXX)
daemon_pid=
cleanup() {
  timeout 15 tailscale --socket="$work/tailscaled.sock" logout >/dev/null 2>&1 || true
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

tailscaled --tun=userspace-networking --state=mem: \
  --socket="$work/tailscaled.sock" >"$work/tailscaled.log" 2>&1 &
daemon_pid=$!
for _ in {1..50}; do
  [[ -S "$work/tailscaled.sock" ]] && break
  kill -0 "$daemon_pid"
  sleep 0.1
done
# A file keeps the OAuth credential out of process arguments.
printf '%s?ephemeral=true&preauthorized=true' "$TS_OAUTH_CLIENT_SECRET" > "$work/authkey"
unset TS_OAUTH_CLIENT_SECRET
tailscale --socket="$work/tailscaled.sock" up --auth-key="file:$work/authkey" \
  --advertise-tags=tag:deploy --hostname="${DEPLOY_USER}-${FORGEJO_RUN_ID:?}-${FORGEJO_RUN_ATTEMPT:-1}" \
  --accept-routes=false --accept-dns=false --timeout=60s
rm -f "$work/authkey"

printf '%s\n' "$DEPLOY_SSH_KEY" > "$work/key"
unset DEPLOY_SSH_KEY
printf '[%s]:2222 %s\n' "$DEPLOY_HOST" "$DEPLOY_HOST_KEY" > "$work/known_hosts"
cat > "$work/ssh_config" <<EOF
Host production
  HostName $DEPLOY_HOST
  Port 2222
  User $DEPLOY_USER
  IdentityFile $work/key
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  UserKnownHostsFile $work/known_hosts
  GlobalKnownHostsFile /dev/null
  ProxyCommand tailscale --socket=$work/tailscaled.sock nc %h %p
  ForwardAgent no
  RequestTTY no
  ConnectTimeout 30
  ServerAliveInterval 15
  ServerAliveCountMax 3
EOF
ssh -F "$work/ssh_config" production "${1:-deploy}"
