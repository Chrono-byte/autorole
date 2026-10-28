import { REST, Routes } from "discord.js";
import { Effect } from "effect";
import { readConfiguration, type Configuration } from "../config/Configuration";
import { AutoroleCommands } from "../bot/AutoroleCommands";
import { tryPromise, trySync } from "../effectful";
import { runMain } from "../runMain";

class CommandRegistrar {
  constructor(private readonly config: Configuration) {}

  register(): Effect.Effect<void, Error> {
    const route = this.config.guildId
      ? Routes.applicationGuildCommands(this.config.applicationId, this.config.guildId)
      : Routes.applicationCommands(this.config.applicationId);
    // Upserting by name preserves unrelated commands and existing permission selections.
    const definitions = AutoroleCommands.definitions;
    return Effect.gen({ self: this }, function* () {
      const rest = yield* trySync(() => new REST({ version: "10" }).setToken(this.config.token));
      for (const definition of definitions) {
        yield* tryPromise((signal) => rest.post(route, { body: definition.toJSON(), signal }));
      }
      yield* Effect.sync(() =>
        process.stdout.write(
          "Registered /autorole and /autorole-target. Select the target role in Server Settings > Integrations.\n",
        ),
      );
    });
  }
}

const program = Effect.gen(function* () {
  const configuration = yield* readConfiguration();
  const registrar = yield* trySync(() => new CommandRegistrar(configuration));
  yield* registrar.register();
});
await runMain(program, "command_registration_failed");
