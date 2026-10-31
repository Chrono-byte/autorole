import {
  ApplicationIntegrationType,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Effect, Result } from "effect";
import {
  CommandCatalog,
  deferEphemeral,
  discordRequest,
  editResponse,
  replyEphemeral,
  subcommands,
} from "@autorole/discord-framework";
import { logError } from "../../logger";
import { RoleService } from "../RoleService";

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

const prebanDefinition = new SlashCommandBuilder()
  .setName("preban")
  .setDescription("Ban a user by ID, including before they join")
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addStringOption((option) =>
    option.setName("user-id").setDescription("Discord user ID").setRequired(true),
  )
  .addStringOption((option) =>
    option.setName("reason").setDescription("Reason for the ban").setMaxLength(400),
  );

const catalog = new CommandCatalog<RoleService>([
  {
    definition: prebanDefinition,
    permissions: {
      guildOnly: true,
      member: PermissionFlagsBits.BanMembers,
      bot: PermissionFlagsBits.BanMembers,
    },
    run: (_, interaction) => preban(interaction),
  },
  {
    definition: statusDefinition,
    run: subcommands<RoleService>([
      {
        name: "status",
        permissions: {
          guildOnly: true,
          member: PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles,
          deniedMessage: "You need Manage Server and Manage Roles to inspect autorole settings.",
        },
        run: (roles, interaction) => status(roles, interaction),
      },
    ]),
  },
  {
    definition: targetDefinition,
    run: (_, interaction) =>
      replyEphemeral(
        interaction,
        "This command marks the autorole configuration. A server administrator selects exactly one allowed role in Server Settings > Integrations > this bot > /autorole-target. Running this command does not assign or change any roles.",
      ),
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
  yield* deferEphemeral(interaction);
  const guild = interaction.guild;
  let content: string;
  if (!guild) {
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
  yield* editResponse(interaction, content);
});

const preban = Effect.fn("AutoroleCommands.preban")(function* (
  interaction: ChatInputCommandInteraction,
) {
  const userId = interaction.options.getString("user-id", true).trim();
  if (!/^\d{17,20}$/.test(userId)) {
    yield* replyEphemeral(interaction, "Enter a valid Discord user ID.");
    return;
  }
  const guild = interaction.guild;
  if (!guild) {
    yield* replyEphemeral(interaction, "This command can only be used in a server.");
    return;
  }
  const reason = interaction.options.getString("reason")?.trim();
  yield* discordRequest(() => interaction.deferReply());
  const user = yield* discordRequest(() => interaction.client.users.fetch(userId));
  yield* discordRequest(() =>
    guild.members.ban(userId, {
      deleteMessageSeconds: 0,
      reason: `By ${interaction.user.id}${reason ? `: ${reason}` : ""}`,
    }),
  );
  yield* discordRequest(() =>
    interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("User banned")
          .setDescription(`${user.tag} (\`${userId}\`)`)
          .setThumbnail(user.displayAvatarURL())
          .addFields({ name: "Reason", value: reason || "No reason provided" }),
      ],
    }),
  );
});
