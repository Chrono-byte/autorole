# Discord bot framework

This private Bun workspace package exposes its public interface as `@autorole/discord-framework`. It uses the workspace’s `discord.js` and Effect installations as peer dependencies; import from the package root rather than internal files. It exports TypeScript source and is intended for Bun or a TypeScript-aware bundler.

The implementation is organized by responsibility:

- `src/commands/`: command catalogs, interaction options, permissions, responses, and subcommand routing.
- `src/runtime/`: client lifecycle, event dispatch, module composition, and presence.
- `src/api/`: Discord request handling and helpers for command registration and roles.

`index.ts` is the public entry point. Tests live in the repository’s `tests/` directory and exercise that entry point.

A small Effect-based framework for discord.js slash commands and typed gateway events. Define each command with a Discord builder and an Effect handler, collect them in a `CommandRegistry`, and pass that registry and event definitions to `install` inside an Effect scope. A `CommandCatalog` keeps definitions available before runtime dependencies exist and binds those dependencies when building a registry. Use `mapContext` to select a feature's dependencies from the application context and `CommandCatalog.combine` to assemble feature catalogs. Registration reads the combined catalog's `definitions`; runtime dispatch uses its `bind` method. Duplicate names fail when catalogs are combined. Use `registry.definitions` with `upsertCommands` to register the same definitions with Discord; upserts leave unrelated commands and permission overrides intact.

```ts
import { Events, SlashCommandBuilder } from "discord.js";
import { Effect } from "effect";
import { CommandRegistry, discordRequest, event, install } from "@autorole/discord-framework";

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

Handlers run in scoped fibers with the installing Effect's context. Event handlers report typed failures, Effect defects, and exceptions thrown before returning an Effect through the installed reporter. Reports inherit a `discordEvent` log annotation. A failed event invocation does not remove the listener or prevent later invocations. Closing the scope removes listeners and interrupts handlers without reporting cancellation as a failure. Duplicate command names are rejected; unknown or non-chat-input interactions are ignored. The package also provides client acquisition, Discord request error classification, command permission lookup, role assignability checks, and presence rotation. `runClient` acquires and closes the client, runs setup before login, and waits for shutdown; callers supply credentials, registration timing, and application-specific policy. It supports slash commands, button handlers, and typed Discord events.

`runBot` combines client lifecycle, module installation, ready and error callbacks, and optional rotating presence. Its `modules` array contains factory functions that receive the client and return scoped Effects producing a command registry and event list. Factories run in declaration order before login; their commands and events are combined in that order. Duplicate command names fail startup before listeners are installed or login occurs. Resources acquired by module factories are released when the enclosing scope closes, including on startup failure.

Modules declare recurring work with a `background` array of task descriptors:

```ts
background: [
  {
    name: "roster-sync",
    interval: "5 minutes",
    timeout: "10 minutes",
    onFailure: "continue",
    run: (client) => refreshRoster(client),
  },
];
```

Each task has a unique name, an Effect duration as its interval, a positive finite `timeout`, a failure policy, and a `run` function for one pass. Duplicate task names and invalid deadlines fail startup before login. `runBot` starts tasks once, in module order, after module ready handlers have started and before the framework ready callback. Configured presence runs last as the supervised task `presence`, with a ten-second deadline; that name is reserved when presence is configured. Each task runs immediately in a separate scoped fiber, then waits its interval after each completed pass. Each pass has its own Effect scope, which releases temporary resources before the next attempt. A task never overlaps its own periodic passes. Different tasks and event handlers can run concurrently.

When a pass exceeds its deadline, Effect interrupts it and waits for cleanup before producing `BackgroundTaskTimeout`. Health records the failure with kind `timeout`, and the task's failure policy determines whether it retries or stops. Cleanup may extend beyond the deadline; the runner waits for it rather than starting an overlapping attempt. Deadlines are cooperative: blocking synchronous code and uninterruptible work must finish before interruption can complete. A timeout does not roll back changes already accepted by Discord, so passes must reconcile current state on retry.

`onFailure: "continue"` reports typed failures, defects, and exceptions thrown by the task factory through `reportHandler`, waits the interval, and runs a fresh pass. `onFailure: "stop"` reports the failure and stops that task while the bot and other tasks continue. Reports carry the `backgroundTask`, `failurePolicy`, and `backgroundTaskStatus` log annotations. Status is `retrying` or `stopped`. Reporting has a separate thirty-second deadline. A broken or timed-out reporter is logged separately and cannot discard the task's recorded failure or terminate its retry loop. Shutdown interrupts every task without reporting cancellation as a failure and prevents further retries. Feature code retains domain-specific recovery, such as deferring an assignment or continuing past one failed member. Periodic roster, guidelines, and counter sweeps fail their pass after processing remaining work if any updates failed.

`runBot` provides the Effect service `BackgroundHealth` to module factories. A module can capture it with `yield* BackgroundHealth` and use its `snapshot` Effect in commands. Snapshots contain each task's name, state, last success, last failure with time and kind, and consecutive failure count. States are `pending`, `running`, `healthy`, `retrying`, and `stopped`; running tasks include their start time, waiting tasks include the next run time, and stopped tasks distinguish failure from shutdown. A completed successful pass sets `healthy` and resets consecutive failures while retaining the last failure for diagnosis. The first success after failure logs `background_task_recovered` once with the task name and failure count. Health snapshots are process-local and start fresh on restart; failure and recovery history remains available through the configured logger.

Sigil's ordered feature list in `src/bot/module.ts` supplies both registration definitions and runtime module factories. Assignment and roster handling, suggestions, member counters, and guidelines each acquire their own resources and register their commands, events, and tasks. Its health module binds `/bot-status` to the framework's health service. Importing registration definitions does not open stores or create a Discord client.

The guidelines module shares one `GuidelinesCoordinator` across commands, member events, and periodic reconciliation. The coordinator serializes renewals and access updates, including period activation and administrative grants. `AgreementStore` owns SQLite transactions and exposes no workflow locks. Agreement reads and atomic acceptance recording use the coordinator's `agreements` view.

Ready event handlers are started in module order before the framework ready callback, but run in separate fibers; they are not awaited to completion. A failed framework ready callback invokes `readyFailed` and shuts the bot down. Scope interruption closes listeners, background fibers, and the client. `composeModules` can also combine already constructed modules when installing without `runBot`.

Commands can declare `permissions` for guild-only, member, and bot permission checks. These checks run on every invocation; registration defaults remain separate. `subcommands` routes direct or grouped subcommands, rejects duplicate routes, and lets each route declare its own permissions. An unknown route fails instead of invoking another handler. Use `options(interaction.options).required` or `.optional` to read Discord options with their existing types and required/nullable behavior.

`deferResponse`, `deferEphemeral`, `replyEphemeral`, and `editResponse` wrap the corresponding Discord calls in Effects. `deferResponse` starts a public response; `editResponse` accepts text or Discord edit options, including embeds and components. The framework reports unexpected command failures and sends a generic message; permission denials use their configured user-facing message without being reported as unexpected failures. If a command has already replied, the framework sends an ephemeral follow-up. For a deferred interaction it edits the original reply, whose visibility was fixed when deferred: a public deferral therefore produces a public generic error. Errors while sending the error response are also reported. The framework does not automatically defer commands.

Use `buttonEvent(matches, run)` to register scoped button interactions with the same error handling as commands. Match only the component IDs your module owns; the framework does not acknowledge or defer the interaction automatically.

`messageTransport(destination)` returns `send(body, replyId?)`, `edit(messageId, body)`, and the selected `webhookId`, or `null` for channel delivery. A channel destination supplies `{ type: "channel", channel }`. A webhook destination supplies `{ type: "webhook", channel, ownerId, name, reason, threadId, identity, webhookId? }`. The identity contains `username` and `avatarURL`. The transport reuses a matching incoming webhook owned by that bot or creates one with the supplied name and reason. Supplying an existing webhook ID requires that exact webhook; an unavailable webhook fails with `WebhookUnavailable` rather than creating a replacement.

A message body supplies `source`, with Discord message content and attachments, and optional presentation `content` and `embeds`. Omitting `content` uses the source text. Setting it to `null` allows the caller to present that text in its own embeds. Source text above 2,000 characters moves into an embed, supporting Discord's 4,000-character member messages. The transport copies attachments, disables mentions, and replaces prior attachments and embeds on edits. Channel sends can reply to a supplied message ID; webhook reply quotes remain the caller's presentation choice. The caller owns message authorization, recipients, sender presentation, reply mapping, and persistence.

`forEachGuildMember(guild, visit, incomplete)` fetches uncached pages of up to 1,000 members and runs an Effect visitor sequentially for each member. It reports Discord failures, visitor failures, or the supplied `incomplete` error if pagination stops advancing. Visitors may already have run when a later page fails. For reconciliation that requires a complete scan, collect candidate changes in the visitor and apply them after the helper succeeds.
