import { Client, DiscordAPIError, Events, GatewayIntentBits } from "discord.js";
import { Configuration } from "../config/Configuration";
import { IntegrationSettings } from "../config/IntegrationSettings";
import { RoleService } from "./RoleService";
import { AutoroleCommands } from "./AutoroleCommands";

import { AssignmentQueue } from "./AssignmentQueue";
import { notifyReady } from "./notifyReady";

export class AutoroleBot {
  private readonly assignments: AssignmentQueue;
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  constructor(private readonly configuration: Configuration) {
    const settings = new IntegrationSettings(configuration);
    const roles = new RoleService(settings);
    const commands = new AutoroleCommands(roles);
    this.assignments = new AssignmentQueue(roles, (error, member, attempt, retrying) => {
      process.stderr.write(
        `${JSON.stringify({ event: "autorole_assignment_error", guildId: member.guild.id, memberId: member.id, attempt, retrying, code: error instanceof DiscordAPIError ? error.code : error instanceof Error && "code" in error ? error.code : undefined, message: error instanceof Error ? error.message : "Unknown error" })}\n`,
      );
    });
    this.client.once(Events.ClientReady, (client) => {
      process.stdout.write(`Connected as ${client.user.tag}\n`);
      void notifyReady().catch((error) => {
        this.report(error);
        process.exitCode = 1;
        void this.stop();
      });
    });
    this.client.on(Events.GuildMemberAdd, (member) => {
      void this.assignments.enqueue(member);
    });
    this.client.on(Events.GuildMemberUpdate, (before, member) => {
      if (before.pending && !member.pending) void this.assignments.enqueue(member);
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
    this.assignments.stop();
    return this.client.destroy();
  }
}
