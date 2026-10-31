import { REST } from "discord.js";
import { Effect } from "effect";
import { upsertCommands } from "@autorole/discord-framework";
import { readConfiguration, type Configuration } from "../config/Configuration";
import { commandDefinitions } from "../bot/commands/AutoroleCommands";
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
        commandDefinitions,
      );
      yield* Effect.sync(() =>
        process.stdout.write(
          "Registered /autorole, /autorole-target, and /preban. Select the target role in Server Settings > Integrations.\n",
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
