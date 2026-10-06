import { REST, Routes } from "discord.js";
import { Configuration } from "./Configuration";
import { AutoroleCommands } from "./AutoroleCommands";

class CommandRegistrar {
  constructor(private readonly config: Configuration) {}

  async register() {
    const rest = new REST({ version: "10" }).setToken(this.config.token);
    const route = this.config.guildId
      ? Routes.applicationGuildCommands(this.config.applicationId, this.config.guildId)
      : Routes.applicationCommands(this.config.applicationId);
    // Upserting by name preserves unrelated commands and existing permission selections.
    for (const definition of AutoroleCommands.definitions) {
      await rest.post(route, { body: definition.toJSON() });
    }
    process.stdout.write(
      "Registered /autorole and /autorole-target. Select the target role in Server Settings > Integrations.\n",
    );
  }
}

await new CommandRegistrar(new Configuration()).register();
