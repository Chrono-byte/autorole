import { Client, Events, GatewayIntentBits } from "discord.js";
import { Configuration } from "./Configuration";
import { IntegrationSettings } from "./IntegrationSettings";
import { RoleService } from "./RoleService";
import { AutoroleCommands } from "./AutoroleCommands";

export class AutoroleBot {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  constructor(private readonly configuration: Configuration) {
    const settings = new IntegrationSettings(configuration);
    const roles = new RoleService(settings);
    const commands = new AutoroleCommands(roles);
    this.client.once(Events.ClientReady, (client) =>
      process.stdout.write(`Connected as ${client.user.tag}\n`),
    );
    this.client.on(Events.GuildMemberAdd, (member) => {
      void roles.assign(member).catch((error) => this.report(error, member.guild.id));
    });
    this.client.on(Events.GuildMemberUpdate, (before, member) => {
      if (before.pending && !member.pending)
        void roles.assign(member).catch((error) => this.report(error, member.guild.id));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      void commands.execute(interaction).catch((error) => this.report(error, interaction.guildId));
    });
    this.client.on(Events.Error, (error) => this.report(error));
  }

  private report(error: unknown, guildId: string | null = null) {
    process.stderr.write(
      `${JSON.stringify({ event: "autorole_error", guildId, message: error instanceof Error ? error.message : "Unknown error" })}\n`,
    );
  }

  start() {
    return this.client.login(this.configuration.token);
  }
  stop() {
    return this.client.destroy();
  }
}
