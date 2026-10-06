import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
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

  async execute(interaction: ChatInputCommandInteraction) {
    switch (interaction.commandName) {
      case AutoroleCommands.statusDefinition.name:
        await this.status(interaction);
        break;
      case AutoroleCommands.targetDefinition.name:
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content:
            "This command marks the autorole configuration. A server administrator selects exactly one allowed role in Server Settings > Integrations > this bot > /autorole-target. Running this command does not assign or change any roles.",
        });
        break;
    }
  }

  private async status(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (
      !guild ||
      !interaction.memberPermissions?.has([
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageRoles,
      ])
    ) {
      await interaction.editReply(
        "You need Manage Server and Manage Roles to inspect autorole settings.",
      );
      return;
    }
    try {
      const role = await this.roles.getConfiguredRole(guild);
      if (!role) {
        await interaction.editReply(
          "Autorole is disabled. In Server Settings > Integrations > this bot > /autorole-target, add exactly one role and enable its checkmark. Save the command-specific permissions.",
        );
        return;
      }
      await interaction.editReply(
        `Autorole: <@&${role.id}>. Bot permissions and hierarchy are valid. New human members receive this role after membership screening. To disable, remove or deny its entry on /autorole-target in Integrations.`,
      );
    } catch (error) {
      await interaction.editReply(
        error instanceof Error ? error.message : "Unable to read Discord integration settings.",
      );
    }
  }
}
