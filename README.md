# Autorole

A Discord bot built with Bun, TypeScript, and discord.js. Assigns a selected role to new human members after membership screening.

## Setup

```sh
bun install
cp .env.example .env
```

Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) and fill in `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID` in `.env`.

Enable **Server Members Intent**, install with the `bot` and `applications.commands` scopes and **Manage Roles** permission, then move the bot's highest role above the role it will assign.

```sh
bun run register
bun run start
```

Set `DISCORD_GUILD_ID` to register in one server; otherwise commands register globally. Keep the same scope when updating to avoid duplicate commands.

## Choose a role

1. Open **Server Settings > Integrations > your bot > /autorole-target**.
2. Under **Roles & Members**, allow exactly one regular role and save. The command should show **Not Synced**.
3. Run `/autorole status` to check the configuration. This requires Manage Server and Manage Roles.

To change roles, remove the old selection and allow the new one. To disable assignment, remove or deny all role selections. Changes apply without restarting.

Use the command's own permissions; app-wide permissions do not select a role. Running `/autorole-target` only shows instructions. Bots are skipped, and existing members or joins while the bot is offline are not backfilled.

## Maintenance

```sh
bun run check                         # Types, lint, formatting, and tests
bun run format                        # Apply lint fixes and formatting
bun run clean-commands --guild        # Remove obsolete slash commands in DISCORD_GUILD_ID
bun run clean-commands --global       # Remove obsolete global slash commands
bun run avatar ./athena.png           # Update the bot avatar from a PNG; requires macOS
```

Command cleanup preserves `/autorole`, `/autorole-target`, and context-menu commands.

## Deploy

Forgejo Actions deploys on pushes to `main`, or manually from the repository's Actions page. The dedicated `deploy` runner installs locked dependencies, runs checks, compiles the executable, and uses the restricted receiver below. Deployments run one at a time and wait for Discord readiness.

`bun run deploy` dispatches that same workflow using an authenticated `fj` CLI. It does not copy local credentials or open an administrative SSH session. Change runtime credentials deliberately on Osiris as an administrator. The CI-only `bun run deploy:artifact` sends an existing `dist/autorole` through the same restricted path, using deployment credentials provided in the job environment.

## Restricted production deployment

The production workflow uses the same isolated SSH client as Guildmaster and the NAS: `deploy/tailscale-ssh.sh`, vendored unchanged from `satet-infra`. Its Tailscale binaries are pinned and checksum-verified. A job-local userspace daemon authenticates as `tag:deploy`; no runner host socket, privileged container, or forwarded agent is needed.

The job connects to `athena@100.65.83.93:2222` using a pinned host key and the repository's `ATHENA_DEPLOY_SSH_KEY`. `TS_OAUTH_CLIENT_SECRET` must be scoped to Auth Keys Write for `tag:deploy`. Runtime credentials remain in `/var/lib/athena/runtime.env`; Athena has no sudo and its service cannot write its executable or configuration.

An administrator installs `deploy/receive.py`, `deploy/athena.service`, and the public key using `sudo bash deploy/setup-osiris.sh prepare PUBLIC_KEY_FILE`. The receiver accepts only `verify` or `deploy`, with a commit SHA, executable checksum and byte count, followed by a bounded Linux x86-64 executable. CI cannot upload service definitions, choose server paths, or run a shell. Cut over with `sudo bash deploy/setup-osiris.sh cutover`; the current live executable and environment are copied, and the legacy service is stopped before the dedicated service starts. A failure stops the replacement before restarting the legacy service.

Systemd's Type=notify checks Discord readiness. Failed updates restore the previous executable. Keep application data migrations compatible with rollback. After the first successful new CI deployment, remove the old repository deployment secret and revoke its public key if it is a deployment-only key; do not remove personal administrator keys.
