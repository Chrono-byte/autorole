import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { Effect } from "effect";
import { CommandRegistry, replyEphemeral } from "@autorole/discord-framework";
import { StatsStore } from "../StatsStore";

export const serverStatsDefinition = new SlashCommandBuilder()
  .setName("member-counter")
  .setDescription("Set the voice channel used for the member counter")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Voice channel for the member counter")
      .addChannelTypes(ChannelType.GuildVoice)
      .setRequired(true),
  );
export function serverStatsCommands(store: StatsStore) {
  return new CommandRegistry([
    {
      definition: serverStatsDefinition,
      permissions: { guildOnly: true, member: PermissionFlagsBits.ManageGuild },
      run: (interaction) =>
        Effect.gen(function* () {
          const guildId = interaction.guildId;
          const channel = interaction.options.getChannel("channel", true);
          if (!guildId || channel.type !== ChannelType.GuildVoice)
            return yield* replyEphemeral(interaction, "Choose a voice channel in this server.");
          yield* store.set(guildId, channel.id);
          yield* replyEphemeral(
            interaction,
            `Member counter set to <#${channel.id}>. It will update within ten minutes.`,
          );
        }),
    },
  ]);
}
