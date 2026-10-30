import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Effect, Result } from "effect";
import { discordRequest } from "../errors";
import { logError } from "../logger";
import { RoleService } from "./RoleService";

export class AutoroleCommands {
  private static readonly statusDefinition = new SlashCommandBuilder()
    .setName("autorole")
    .setDescription("Show automatic role settings and setup instructions")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("Check the role selected in Integrations and bot permissions"),
    );

  private static readonly targetDefinition = new SlashCommandBuilder()
    .setName("autorole-target")
    .setDescription(
      "Select the autorole via this command's allowed role in Server Settings > Integrations",
    )
    .setDefaultMemberPermissions(0n)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

  static readonly definitions = [this.statusDefinition, this.targetDefinition];

  constructor(private readonly roles: RoleService) {}

  execute = Effect.fn("AutoroleCommands.execute")(function* (
    this: AutoroleCommands,
    interaction: ChatInputCommandInteraction,
  ) {
    switch (interaction.commandName) {
      case AutoroleCommands.statusDefinition.name:
        yield* this.status(interaction);
        break;
      case AutoroleCommands.targetDefinition.name:
        yield* discordRequest(() =>
          interaction.reply({
            flags: MessageFlags.Ephemeral,
            content:
              "This command marks the autorole configuration. A server administrator selects exactly one allowed role in Server Settings > Integrations > this bot > /autorole-target. Running this command does not assign or change any roles.",
          }),
        );
        break;
    }
  });

  private status = Effect.fn("AutoroleCommands.status")(function* (
    this: AutoroleCommands,
    interaction: ChatInputCommandInteraction,
  ) {
    yield* discordRequest(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }));
    const guild = interaction.guild;
    let content: string;
    if (
      !guild ||
      !interaction.memberPermissions?.has([
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
      ])
    ) {
      content = "You need Manage Server and Manage Roles to inspect autorole settings.";
    } else {
      const result = yield* Effect.result(this.roles.getConfiguredRole(guild));
      if (Result.isFailure(result)) {
        yield* logError("autorole_status_failed", {
          guildId: guild.id,
          message: result.failure.message,
        });
        content = result.failure.message || "Unable to read Discord integration settings.";
      } else if (result.success === null) {
        content =
          "Autorole is disabled. In Server Settings > Integrations > this bot > /autorole-target, add exactly one role and enable its checkmark. Save the command-specific permissions.";
      } else {
        content = `Autorole: <@&${result.success.id}>. Bot permissions and hierarchy are valid. New human members receive this role after membership screening. To disable, remove or deny its entry on /autorole-target in Integrations.`;
      }
    }
    yield* discordRequest(() => interaction.editReply(content));
  });
}
