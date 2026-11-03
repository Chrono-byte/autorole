import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
} from "discord.js";
import { Effect, Result } from "effect";
import {
  CommandRegistry,
  deferEphemeral,
  discordRequest,
  editResponse,
  replyEphemeral,
} from "@autorole/discord-framework";
import { reconcileTeamGate, teamRolesFromEnv, validateTeamGate } from "./TeamGate";
import { rosterGuildId } from "../commands/syncRoster";
import { AgreementStore } from "./AgreementStore";

const prefix = "guidelines:agree:";
const guidelinesChannelId = "1566875132658458675";
export const guidelinesDefinition = new SlashCommandBuilder()
  .setName("guidelines-renew")
  .setDescription("Start a new guidelines agreement period")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addStringOption((o) =>
    o
      .setName("period")
      .setDescription("Semester, such as Fall 2026")
      .setMaxLength(80)
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("version")
      .setDescription("Approved document version")
      .setMaxLength(80)
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("message-id")
      .setDescription("ID of the bot's agreement message in team-guidelines")
      .setRequired(true),
  );

export const guidelinesStatusDefinition = new SlashCommandBuilder()
  .setName("guidelines-status")
  .setDescription("Check outstanding agreements or a member's history")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addUserOption((o) => o.setName("member").setDescription("Show this member's agreement history"));

export function guidelinesCommands(store: AgreementStore) {
  return new CommandRegistry([
    {
      definition: guidelinesStatusDefinition,
      permissions: { guildOnly: true, member: PermissionFlagsBits.ManageGuild },
      run: (interaction) =>
        Effect.gen(function* () {
          const guild = interaction.guild;
          const mapping = teamRolesFromEnv();
          if (!guild || guild.id !== rosterGuildId || !mapping)
            return yield* replyEphemeral(
              interaction,
              "The team gate is not configured for this server.",
            );
          yield* deferEphemeral(interaction);
          const member = interaction.options.getUser("member");
          if (member) {
            const history = yield* store.history(guild.id, member.id);
            const lines = history.map(
              (h) => `${h.period} (version ${h.version}): <t:${Math.floor(h.agreedAt / 1000)}:f>`,
            );
            return yield* editResponse(
              interaction,
              `Agreement history for ${member.id}:\n${lines.join("\n").slice(0, 1500) || "No recorded agreements."}`,
            );
          }
          const active = yield* store.active(guild.id);
          if (!active) return yield* editResponse(interaction, "No active agreement period.");
          const missing: string[] = [];
          let after: string | undefined;
          for (;;) {
            const page = yield* discordRequest(() =>
              guild.members.list({ limit: 1000, after, cache: false }),
            );
            for (const entry of page.values()) {
              if (
                !entry.user.bot &&
                mapping.some((x) => x.identity.some((id) => entry.roles.cache.has(id))) &&
                !(yield* store.getAcceptance(active.id, entry.id))
              )
                missing.push(entry.id);
            }
            if (page.size < 1000) break;
            const last = page.last();
            if (!last || last.id === after)
              return yield* editResponse(
                interaction,
                "Could not read all members; status is incomplete.",
              );
            after = last.id;
          }
          return yield* editResponse(
            interaction,
            `${active.period}: ${missing.length} eligible members have not agreed.\n${missing.join("\n").slice(0, 1500) || "None."}`,
          );
        }),
    },
    {
      definition: guidelinesDefinition,
      permissions: { guildOnly: true, member: PermissionFlagsBits.ManageGuild },
      run: (interaction) =>
        Effect.gen(function* () {
          const guildId = interaction.guildId;
          const period = interaction.options.getString("period", true).trim();
          const version = interaction.options.getString("version", true).trim();
          const messageId = interaction.options.getString("message-id", true).trim();
          if (!guildId || !period || !version || !/^\d{17,20}$/.test(messageId))
            return yield* replyEphemeral(
              interaction,
              "Enter a valid agreement message ID, period, and version.",
            );
          const mapping = teamRolesFromEnv();
          const guild = interaction.guild;
          if (guildId !== rosterGuildId || !mapping || !guild)
            return yield* replyEphemeral(
              interaction,
              "Configure all three pending team roles before starting a renewal in the Overwatch server.",
            );
          yield* deferEphemeral(interaction);
          const validation = yield* Effect.result(validateTeamGate(guild, mapping));
          if (Result.isFailure(validation))
            return yield* editResponse(
              interaction,
              `Cannot start renewal: ${validation.failure.message}`,
            );
          const channel = yield* discordRequest(() => guild.channels.fetch(guidelinesChannelId));
          if (!channel || !channel.isTextBased() || !("messages" in channel))
            return yield* editResponse(interaction, "The team-guidelines channel is unavailable.");
          const fetched = yield* Effect.result(
            discordRequest(() => channel.messages.fetch(messageId)),
          );
          if (Result.isFailure(fetched)) {
            if (fetched.failure.code === 10008)
              return yield* editResponse(
                interaction,
                "Message not found in #team-guidelines. Copy the ID of the Agree message and try again.",
              );
            return yield* fetched.failure;
          }
          const message = fetched.success;
          if (message.author.id !== interaction.client.user.id)
            return yield* editResponse(
              interaction,
              "Choose a guidelines message sent by this bot.",
            );
          const id = interaction.id;
          const button = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`${prefix}${id}`)
              .setLabel("Agree")
              .setStyle(ButtonStyle.Primary),
          );
          yield* discordRequest(() => message.edit({ components: [button] }));
          yield* store.startPeriod({
            id,
            guildId,
            channelId: channel.id,
            messageId,
            period,
            version,
            startedAt: interaction.createdTimestamp,
          });
          const result = yield* Effect.result(reconcileTeamGate(guild, store, mapping));
          if (Result.isFailure(result))
            return yield* editResponse(
              interaction,
              `Started ${period}, but team role reconciliation failed: ${result.failure.message}. The bot will retry.`,
            );
          const { failed, conflicts } = result.success;
          const detail = [
            ...failed.map((memberId) => `Update failed: ${memberId}`),
            ...conflicts.map((memberId) => `Permission bypass: ${memberId}`),
          ]
            .join("\n")
            .slice(0, 1500);
          yield* editResponse(
            interaction,
            `Started ${period} for version ${version}. ${failed.length} updates failed; ${conflicts.length} members have bypassing overrides.${detail ? `\n${detail}` : ""}`,
          );
        }),
    },
  ]);
}

export function guidelinesButton(store: AgreementStore, interaction: ButtonInteraction) {
  return Effect.gen(function* () {
    const guildId = interaction.guildId;
    const periodId = interaction.customId.slice(prefix.length);
    if (!guildId || interaction.user.bot)
      return yield* replyEphemeral(
        interaction,
        "This agreement is only available to server members.",
      );
    const active = yield* store.active(guildId);
    if (
      !active ||
      active.id !== periodId ||
      active.channelId !== interaction.channelId ||
      active.messageId !== interaction.message.id
    )
      return yield* replyEphemeral(
        interaction,
        "This agreement is no longer active. Ask an officer for the current one.",
      );
    yield* store.acceptCurrent(
      guildId,
      periodId,
      interaction.channelId,
      interaction.message.id,
      interaction.user.id,
      interaction.createdTimestamp,
    );
    const saved = yield* store.getAcceptance(periodId, interaction.user.id);
    if (!saved)
      return yield* replyEphemeral(
        interaction,
        "This agreement is no longer active. Ask an officer for the current one.",
      );
    yield* replyEphemeral(
      interaction,
      `Your agreement for ${active.period} (version ${active.version}) is recorded.`,
    );
  });
}
export const isGuidelinesButton = (interaction: ButtonInteraction) =>
  interaction.customId.startsWith(prefix);
