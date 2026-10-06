# Autorole

Class-based TypeScript Discord bot using discord.js and Bun. Configure the role directly in **Server Settings > Integrations**. The bot reads the explicitly allowed role on a dedicated `/autorole-target` command and assigns it to new human members after membership screening.

## Install

```sh
bun add discord.js
bun add -d typescript @types/bun oxlint oxfmt
cp .env.example .env
```

Create a bot at https://discord.com/developers/applications. Fill `.env` with its token and application ID. Enable **Server Members Intent** on the Bot page. Under Installation, enable Guild Install with `bot` and `applications.commands` scopes and **Manage Roles** permission. Install the bot and move its highest role above the intended autorole.

```sh
bun run register
bun run start
```

Optional `DISCORD_GUILD_ID` registers commands only in one test server. Otherwise commands register globally. Registration upserts these two commands and preserves unrelated commands. Keep the same registration scope when updating; switching from guild to global requires removing old guild commands to avoid duplicates.

## Select the role in Integrations

1. Open **Server Settings > Integrations > your bot**.
2. Select the **/autorole-target** command itself, rather than the app-wide permissions at the top.
3. Add the role you want new members to receive under **Roles & Members** and enable its green checkmark.
4. Keep exactly one regular role allowed on this command and save. The command should have its own permissions, shown as **Not Synced**.
5. Run `/autorole status` to verify the selected role and bot permissions.

To change the role, remove or deny the old entry and allow the new one. To disable assignment, remove or deny all regular role entries on `/autorole-target`. Existing member roles remain.

This uses Discord's command-permission selectors as configuration. Discord still displays them as access permissions, and the allowed role can invoke `/autorole-target`. That command only displays instructions; it never modifies settings or assigns roles. App-wide permissions, user entries, channel entries, denied roles and @everyone do not select an autorole. Multiple allowed roles cause assignment to stop with an error instead of choosing one arbitrarily.

Discord stores the settings. The bot fetches explicit permissions before each assignment, so saved changes apply to the next eligible member without restarting. It fails without assigning a role if the permissions request fails. The bot needs Manage Roles and a higher role than the target. Configuration through Discord follows Discord's own permission checks. `/autorole status` requires Manage Server and Manage Roles.

Bots are skipped. Membership screening must finish before role assignment. Existing members and joins while the bot is offline are not backfilled. Deleted roles and missing permissions produce structured errors in stderr. The previous SQLite settings and `/autorole set` or `/autorole disable` commands are no longer used; select your role in Integrations after updating.

## Verify

```sh
bun run format
bun run check
```

Tests cover permission selection and environment validation, plus the path from command-permission responses through real discord.js managers to the role-assignment request. Only Discord network responses are mocked. Assignment tests cover changing and disabling selections, global and guild commands, screening, skipped bots and existing roles, role hierarchy, missing permissions, and API failures. For live verification, configure a target in Integrations, join with a human test account, complete screening and confirm assignment. Switch roles in Integrations and verify a second account receives the new role. Remove allowed role entries and confirm another join receives no role. Requires a real bot token and test server.

## Remove obsolete slash commands

```sh
bun run clean-commands --guild
bun run clean-commands --global
```

This deletes slash commands belonging to this application that are not listed in `AutoroleCommands.definitions`. It preserves `/autorole`, `/autorole-target`, their permission selections, and user/message context-menu commands. Choose exactly one scope. `--guild` cleans only the server in `DISCORD_GUILD_ID` and requires that setting. `--global` cleans only global commands, even when a guild ID is configured. It does not register missing commands. Run `bun run register` separately when needed.

## Bot avatar

On macOS, run `bun run avatar` to apply the original blue Athena image using discord.js and the bot token in `.env`. The script uses Swift and macOS Core Graphics to center the image on a larger square canvas whose color matches the original border, then feather its outer edges into the padding. The central logo and lettering remain unchanged, with room for Discord’s circular crop. It saves the original at `assets/athena-source.png` and the padded version at `assets/athena-avatar.png`. To use a downloaded PNG, run `bun run avatar ./athena.png`. The script reads the bot profile after updating it to verify the avatar.

## Formatting and linting

Oxfmt and Oxlint are installed as development dependencies. Project rules live in `.oxfmtrc.json` and `.oxlintrc.json`. Run `bun run format` to format files, `bun run lint` to lint, or `bun run lint:fix` to apply safe lint fixes. `bun run check` checks types, lint, formatting and tests. Temporary files and image assets are excluded.

Project-local Zed settings enable Oxfmt on save for TypeScript, JavaScript, JSON, JSONC and Markdown. Zed tasks provide project check, lint and formatting commands. For inline lint diagnostics, install the Oxc extension from Zed’s extension browser.
