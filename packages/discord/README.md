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

`runBot` combines client lifecycle, module installation, ready and error callbacks, and optional rotating presence. Its `modules` array contains factory functions that receive the client and return scoped Effects producing a command registry and event list. Factories run in declaration order before login; their commands and events are combined in that order. Duplicate command names fail startup before listeners are installed or login occurs. Resources acquired by module factories are released when the enclosing scope closes, including on startup failure.

Ready event handlers are started in module order before the framework ready callback, but run in separate fibers; they are not awaited to completion. A failed framework ready callback invokes `readyFailed` and shuts the bot down. Scope interruption closes listeners, background fibers, and the client. `composeModules` can also combine already constructed modules when installing without `runBot`.

Commands can declare `permissions` for guild-only, member, and bot permission checks. These checks run on every invocation; registration defaults remain separate. `subcommands` routes direct or grouped subcommands, rejects duplicate routes, and lets each route declare its own permissions. An unknown route fails instead of invoking another handler. Use `options(interaction.options).required` or `.optional` to read Discord options with their existing types and required/nullable behavior.

`deferEphemeral`, `replyEphemeral`, and `editResponse` wrap the corresponding Discord calls in Effects. The framework reports unexpected command failures and sends a generic message; permission denials use their configured user-facing message without being reported as unexpected failures. If a command has already replied, the framework sends an ephemeral follow-up. For a deferred interaction it edits the original reply, whose visibility was fixed when deferred: a public deferral therefore produces a public generic error. Errors while sending the error response are also reported. The framework does not automatically defer commands.
