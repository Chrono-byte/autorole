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

Forgejo Actions deploys on pushes to `main`, or manually from the repository's Actions page. The workflow uses the `ci` runner to install locked dependencies, run checks, compile the executable, and deploy to hermes over SSH. Deployments run one at a time and wait until the bot connects to Discord.

Repository secrets are `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, and `DEPLOY_KNOWN_HOSTS`. The dedicated deploy key and pinned host key are configured. Discord credentials stay on hermes at `~/.config/autorole/env`; Actions does not read or replace them. The runner must be able to reach hermes over Tailscale.

For a local deployment that also updates the server's Discord credentials:

```sh
bun run deploy user@host
```

Checks the project, compiles a standalone Linux executable, and deploys it over SSH as a systemd user service. The destination needs `systemd-notify` and a working user systemd session.

`bun run deploy:artifact user@host` deploys an existing `dist/autorole` without replacing credentials. This is the command the workflow uses.
