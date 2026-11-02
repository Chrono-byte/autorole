# Autorole

A Discord bot built with Bun, TypeScript, Effect, and discord.js. Assigns a selected role to new human members after membership screening.

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

Use the command's own permissions; app-wide permissions do not select a role. Running `/autorole-target` only shows instructions. Bots are skipped, and existing members or joins while the bot is offline are not backfilled. Observed joins awaiting screening or assignment are stored in SQLite and retried after restarts. Set `AUTOROLE_STATE_PATH` to choose the database path (default `./data/assignments.sqlite`).

Pending screening, disabled autorole, and configuration or permission failures are rechecked every five minutes. Transient Discord failures use exponential backoff from one minute to one hour. Outstanding assignments remain in SQLite until completed or the member leaves. Logs retain systemd journal priorities and include Effect fiber and trace identifiers.

## Sync the roster

In Overwatch Esports at IUI, `/sync-roster` adds Player to members with IUI Crimson, IUI White, or IUI Black and removes Player from members without any of those team roles. It runs on demand and reports failures. The caller needs Manage Server and Manage Roles, and both the caller and the bot must have a role above Player.

## Pre-ban a user

Use `/preban` with a Discord user ID and an optional reason to ban a user before they join. Both you and the bot need Ban Members permission.

## Suggestions

In the IUI server, the button in `#suggestions` opens a private DM with Sigil and an officer thread. Officers and the esports advisor can read and reply to suggestions, as can server administrators. Each person can have one open conversation; the member or a moderator can close or reopen it with the buttons. The panel offers a choice to continue a previous suggestion or start a new one.

Member messages appear in officer threads under their name and avatar through a bot-owned webhook. Officer replies arrive in DMs with the officer's name, username, and avatar. Text and attachments are relayed without delivery reactions. Edits update the delivered copy. Replies in DMs use native Discord replies; replies relayed into threads include a quote linked to the corresponding message.

Conversation history and message links are stored alongside the assignment database in a separate SQLite file, so closing, reopening, replies, and edits survive restarts. Edit and reply matching applies to messages relayed after this feature was installed. Messages and edits made while the bot is offline are not automatically replayed.

Enable Discord's **Message Content Intent** and the bot's server-member intent. The officer inbox must remain private and inside the Officers category. Grant Sigil **Manage Webhooks** in the inbox channel; it creates and reuses its own webhook there. Webhook tokens are fetched from Discord rather than saved in SQLite.

After deploying the bot, run `bun run setup:suggestions` with Sigil's token and application ID configured. This installs or updates the button and prevents members from posting publicly in `#suggestions`.

## Maintenance

```sh
bun run check                         # Types, lint, formatting, and tests
bun run format                        # Apply lint fixes and formatting
bun run clean-commands --guild        # Remove obsolete slash commands in DISCORD_GUILD_ID
bun run clean-commands --global       # Remove obsolete global slash commands
bun run avatar ./athena.png           # Update the bot avatar from a PNG; requires macOS
```

Command cleanup preserves `/autorole`, `/autorole-target`, `/preban`, `/sync-roster`, and context-menu commands.

## Server member counter

Sigil displays the number of human members in a voice channel, excluding bots. The channel is configured per server with `/member-counter channel`, which requires Manage Server. Sigil needs View Channel and Manage Channels on the selected channel and the Server Members Intent. Settings are stored in SQLite and survive restarts and deployments. The IUI Overwatch channel is seeded on first startup; later command changes are preserved. Counts refresh at startup and every ten minutes. Discord groups voice channels beneath text channels in a category.
