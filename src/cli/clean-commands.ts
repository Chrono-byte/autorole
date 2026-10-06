import { ApplicationCommandType, REST, Routes } from "discord.js";
import { AutoroleCommands } from "../bot/AutoroleCommands";
import { Configuration } from "../config/Configuration";

export class CommandCleaner {
  constructor(
    private readonly config: Configuration,
    private readonly rest = new REST({ version: "10" }).setToken(config.token),
  ) {}

  async clean(scope: "guild" | "global") {
    const guildId = scope === "guild" ? this.config.guildId : undefined;
    if (scope === "guild" && !guildId) throw new Error("Set DISCORD_GUILD_ID to use --guild.");
    const route = guildId
      ? Routes.applicationGuildCommands(this.config.applicationId, guildId)
      : Routes.applicationCommands(this.config.applicationId);
    const commands = this.parseCommands(await this.rest.get(route));
    const ours = new Set(AutoroleCommands.definitions.map((definition) => definition.name));
    const obsolete = commands.filter(
      (command) => command.type === ApplicationCommandType.ChatInput && !ours.has(command.name),
    );
    for (const command of obsolete) {
      const deleteRoute = guildId
        ? Routes.applicationGuildCommand(this.config.applicationId, guildId, command.id)
        : Routes.applicationCommand(this.config.applicationId, command.id);
      await this.rest.delete(deleteRoute);
      process.stdout.write(`Removed /${command.name}\n`);
    }
    process.stdout.write(`Removed ${obsolete.length} obsolete slash command(s).\n`);
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
  if (args.length !== 1 || (flag !== "--guild" && flag !== "--global")) {
    throw new Error("Usage: bun run clean-commands --guild | --global");
  }
  await new CommandCleaner(new Configuration()).clean(flag === "--guild" ? "guild" : "global");
}
