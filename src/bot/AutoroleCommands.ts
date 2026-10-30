import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Effect, Result } from "effect";
import { CommandCatalog } from "../../packages/discord/framework";
import { discordRequest } from "../errors";
import { logError } from "../logger";
import { RoleService } from "./RoleService";

const statusDefinition = new SlashCommandBuilder()
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

const targetDefinition = new SlashCommandBuilder()
  .setName("autorole-target")
  .setDescription(
    "Select the autorole via this command's allowed role in Server Settings > Integrations",
  )
  .setDefaultMemberPermissions(0n)
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);

const catalog = new CommandCatalog<RoleService>([
  { definition: statusDefinition, run: (roles, interaction) => status(roles, interaction) },
  {
    definition: targetDefinition,
    run: (_, interaction) =>
      discordRequest(() =>
        interaction.reply({
          flags: MessageFlags.Ephemeral,
          content:
            "This command marks the autorole configuration. A server administrator selects exactly one allowed role in Server Settings > Integrations > this bot > /autorole-target. Running this command does not assign or change any roles.",
        }),
      ).pipe(Effect.asVoid),
  },
]);

export const commandDefinitions = catalog.definitions;

export function makeCommandRegistry(roles: RoleService) {
  return catalog.bind(roles);
}

const status = Effect.fn("AutoroleCommands.status")(function* (
  roles: RoleService,
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
    const result = yield* Effect.result(roles.getConfiguredRole(guild));
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
