import { REST } from "discord.js";
import { Effect } from "effect";
import { upsertCommands } from "../../packages/discord/commands";
import { readConfiguration, type Configuration } from "../config/Configuration";
import { AutoroleCommands } from "../bot/AutoroleCommands";
import { trySync } from "../effectful";
import { runMain } from "../runMain";

class CommandRegistrar {
  constructor(private readonly config: Configuration) {}

  register(): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const rest = yield* trySync(() => new REST({ version: "10" }).setToken(this.config.token));
      yield* upsertCommands(
        rest,
        this.config.applicationId,
        this.config.guildId,
        AutoroleCommands.definitions,
      );
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
