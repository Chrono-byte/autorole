import { ApplicationCommandType, REST, Routes } from "discord.js";
import { Effect } from "effect";
import { AutoroleCommands } from "../bot/AutoroleCommands";
import { readConfiguration, type Configuration } from "../config/Configuration";
import { tryPromise, trySync } from "../effectful";
import { runMain } from "../runMain";

export class CommandCleaner {
  constructor(
    private readonly config: Configuration,
    private readonly rest = new REST({ version: "10" }).setToken(config.token),
  ) {}

  clean(scope: "guild" | "global"): Effect.Effect<void, Error> {
    const guildId = scope === "guild" ? this.config.guildId : undefined;
    if (scope === "guild" && !guildId)
      return Effect.fail(new Error("Set DISCORD_GUILD_ID to use --guild."));
    const route = guildId
      ? Routes.applicationGuildCommands(this.config.applicationId, guildId)
      : Routes.applicationCommands(this.config.applicationId);
    const rest = this.rest;
    const parseCommands = this.parseCommands.bind(this);
    const configuration = this.config;
    return Effect.gen(function* () {
      const data = yield* tryPromise((signal) => rest.get(route, { signal }));
      const commands = yield* trySync(() => parseCommands(data));
      const ours = new Set(AutoroleCommands.definitions.map((definition) => definition.name));
      const obsolete = commands.filter(
        (command) => command.type === ApplicationCommandType.ChatInput && !ours.has(command.name),
      );
      for (const command of obsolete) {
        const deleteRoute = guildId
          ? Routes.applicationGuildCommand(configuration.applicationId, guildId, command.id)
          : Routes.applicationCommand(configuration.applicationId, command.id);
        yield* tryPromise((signal) => rest.delete(deleteRoute, { signal }));
        yield* Effect.sync(() => process.stdout.write(`Removed /${command.name}\n`));
      }
      yield* Effect.sync(() =>
        process.stdout.write(`Removed ${obsolete.length} obsolete slash command(s).\n`),
      );
    });
  }

  private parseCommands(data: unknown) {
    if (!Array.isArray(data)) throw new Error("Discord returned an invalid command list.");
    return data.map((entry: unknown) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("id" in entry) ||
        typeof entry.id !== "string" ||
        !/^\d{17,20}$/.test(entry.id) ||
        !("name" in entry) ||
        typeof entry.name !== "string" ||
        !("type" in entry) ||
        typeof entry.type !== "number"
      )
        throw new Error("Discord returned an invalid command. No commands were removed.");
      return { id: entry.id, name: entry.name, type: entry.type };
    });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = args[0];
  const program = Effect.gen(function* () {
    if (args.length !== 1 || (flag !== "--guild" && flag !== "--global"))
      return yield* Effect.fail(new Error("Usage: bun run clean-commands --guild | --global"));
    const configuration = yield* readConfiguration();
    const cleaner = yield* trySync(() => new CommandCleaner(configuration));
    yield* cleaner.clean(flag === "--guild" ? "guild" : "global");
  });
  await runMain(program, "command_cleanup_failed");
}
