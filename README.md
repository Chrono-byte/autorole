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

```sh
bun run deploy
```

Checks the project, compiles a standalone Linux executable, and deploys to `chrono@hermes` as a systemd user service. Credentials are stored separately in `~/.config/autorole/env`.

```sh
ssh chrono@hermes systemctl --user status autorole.service
ssh chrono@hermes journalctl --user -u autorole.service -n 50 --no-pager
```
