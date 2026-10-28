import { ActivityType, Client, DiscordAPIError, Events, GatewayIntentBits } from "discord.js";
import { type Configuration } from "../config/Configuration";
import { IntegrationSettings } from "../config/IntegrationSettings";
import { RoleService } from "./RoleService";
import { AutoroleCommands } from "./AutoroleCommands";

import { OutstandingAssignments } from "./OutstandingAssignments";
import { notifyReady } from "./notifyReady";

const overwatchStatuses = [
  "Escorting the payload",
  "Contesting the point",
  "Cheers, love! The cavalry's here!",
  "It's high noon.",
  "Ryūjin no ken wo kurae!",
  "Justice rains from above!",
  "D.Va: 1, Bad guys: 0.",
  "Heroes never die!",
  "Nerf this!",
  "The world could always use more heroes",
  "Would you like to see my muscles?",
  "Propaganda is useless.",
  "Boop!",
  "egg",
] satisfies [string, ...string[]];

export class AutoroleBot {
  private presenceTimer: ReturnType<typeof setInterval> | undefined;
  private readonly assignments: OutstandingAssignments;
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  constructor(private readonly configuration: Configuration) {
    const settings = new IntegrationSettings(configuration.guildId);
    const roles = new RoleService(settings);
    const commands = new AutoroleCommands(roles);
    this.assignments = new OutstandingAssignments(
      process.env.AUTOROLE_STATE_PATH ||
        (process.env.STATE_DIRECTORY
          ? `${process.env.STATE_DIRECTORY}/assignments.sqlite`
          : "./data/assignments.sqlite"),
      this.client,
      roles,
      (error, guildId, memberId) => {
        process.stderr.write(
          `${JSON.stringify({ event: "autorole_assignment_error", guildId, memberId, code: error instanceof DiscordAPIError ? error.code : undefined, message: error instanceof Error ? error.message : "Unknown error" })}\n`,
        );
      },
      configuration.guildId,
    );
    this.client.once(Events.ClientReady, (client) => {
      this.assignments.start();
      let statusIndex = 0;
      const updatePresence = () => {
        client.user.setPresence({
          activities: [
            {
              name: "Overwatch",
              type: ActivityType.Custom,
              state: overwatchStatuses[statusIndex] ?? overwatchStatuses[0],
            },
          ],
          status: "online",
        });
        statusIndex = (statusIndex + 1) % overwatchStatuses.length;
      };
      updatePresence();
      this.presenceTimer = setInterval(updatePresence, 60_000);
      this.presenceTimer.unref();
      process.stdout.write(`Connected as ${client.user.tag}\n`);
      void notifyReady().catch((error) => {
        this.report(error);
        process.exitCode = 1;
        void this.stop();
      });
    });
    this.client.on(Events.GuildMemberAdd, (member) => {
      this.assignments.observeJoin(member);
    });
    this.client.on(Events.GuildMemberUpdate, (before, member) => {
      if (before.pending && !member.pending) this.assignments.observe(member);
    });
    this.client.on(Events.GuildMemberAvailable, (member) => {
      this.assignments.observe(member);
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
    clearInterval(this.presenceTimer);
    this.assignments.stop();
    return this.client.destroy();
  }
}
