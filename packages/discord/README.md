# Discord bot framework

A small Effect-based framework for discord.js slash commands and typed gateway events. Define each command with a Discord builder and an Effect handler, collect them in a `CommandRegistry`, and pass that registry and event definitions to `install` inside an Effect scope. A `CommandCatalog` keeps definitions available before runtime dependencies exist and binds those dependencies when building a registry. Use `registry.definitions` with `upsertCommands` to register the same definitions with Discord; upserts leave unrelated commands and permission overrides intact.

```ts
import { Events, SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";
import { CommandRegistry, discordRequest, event, install } from "./index";

const commands = new CommandRegistry([
  {
    definition: new SlashCommandBuilder().setName("ping").setDescription("Reply to a ping"),
    run: (interaction) => discordRequest(() => interaction.reply("Pong!")).pipe(Effect.asVoid),
  },
]);

const events = [event(Events.Error, (error) => Effect.logError(error.message))];
// In a scoped Effect with an acquired Discord client:
// yield* install(client, commands, events, (error) => Effect.logError(error.message));
```

Handlers run in scoped fibers with the installing Effect's context. Closing the scope removes listeners and interrupts handlers. Duplicate command names are rejected; unknown or non-chat-input interactions are ignored. The package also provides client acquisition, Discord request error classification, command permission lookup, role assignability checks, and presence rotation. `runClient` acquires and closes the client, runs setup before login, and waits for shutdown; callers supply credentials, registration timing, and application-specific policy. It currently supports slash commands and typed Discord events.

`runBot` combines client lifecycle, module installation, ready and error callbacks, and optional rotating presence. Its setup function returns a registry and event list; setup runs before login, module ready events run before the framework ready callback, and a failed ready callback invokes `readyFailed` and shuts the bot down. Scope interruption closes listeners, background fibers, and the client.
