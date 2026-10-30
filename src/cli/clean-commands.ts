import { ApplicationCommandType, REST, Routes } from "discord.js";
import { Effect, Schema } from "effect";
import { commandDefinitions } from "../bot/AutoroleCommands";
import { readConfiguration, type Configuration } from "../config/Configuration";
import { trySync } from "../effectful";
import { ConfigurationError, discordRequest } from "../errors";
import { runMain } from "../runMain";

const decodeCommands = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^\d{17,20}$/)),
      name: Schema.String,
      type: Schema.Number,
    }),
  ),
);

export class CommandCleaner {
  constructor(
    private readonly config: Configuration,
    private readonly rest = new REST({ version: "10" }).setToken(config.token),
  ) {}

  clean(scope: "guild" | "global"): Effect.Effect<void, Error> {
    const guildId = scope === "guild" ? this.config.guildId : undefined;
    if (scope === "guild" && !guildId)
      return Effect.fail(
        new ConfigurationError({ message: "Set DISCORD_GUILD_ID to use --guild." }),
      );
    const route = guildId
      ? Routes.applicationGuildCommands(this.config.applicationId, guildId)
      : Routes.applicationCommands(this.config.applicationId);
    const rest = this.rest;
    const configuration = this.config;
    return Effect.gen(function* () {
      const data = yield* discordRequest((signal) => rest.get(route, { signal }));
      const commands = yield* decodeCommands(data).pipe(
        Effect.mapError(
          () =>
            new ConfigurationError({
              message: "Discord returned an invalid command list. No commands were removed.",
            }),
        ),
      );
      const ours = new Set(commandDefinitions.map((definition) => definition.name));
      const obsolete = commands.filter(
        (command) => command.type === ApplicationCommandType.ChatInput && !ours.has(command.name),
      );
      for (const command of obsolete) {
        const deleteRoute = guildId
          ? Routes.applicationGuildCommand(configuration.applicationId, guildId, command.id)
          : Routes.applicationCommand(configuration.applicationId, command.id);
        yield* discordRequest((signal) => rest.delete(deleteRoute, { signal }));
        yield* Effect.sync(() => process.stdout.write(`Removed /${command.name}\n`));
      }
      yield* Effect.sync(() =>
        process.stdout.write(`Removed ${obsolete.length} obsolete slash command(s).\n`),
      );
    });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = args[0];
  const program = Effect.gen(function* () {
    if (args.length !== 1 || (flag !== "--guild" && flag !== "--global"))
      return yield* Effect.fail(
        new ConfigurationError({ message: "Usage: bun run clean-commands --guild | --global" }),
      );
    const configuration = yield* readConfiguration();
    const cleaner = yield* trySync(() => new CommandCleaner(configuration));
    yield* cleaner.clean(flag === "--guild" ? "guild" : "global");
  });
  await runMain(program, "command_cleanup_failed");
}
