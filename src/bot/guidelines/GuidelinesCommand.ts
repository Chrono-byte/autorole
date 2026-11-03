import {
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
} from "discord.js";
import { Effect } from "effect";
import {
  CommandRegistry,
  deferEphemeral,
  discordRequest,
  editResponse,
  replyEphemeral,
} from "@autorole/discord-framework";
import { teamRolesFromEnv } from "./TeamGate";
import { rosterGuildId } from "../commands/syncRoster";
import { AgreementStore } from "./AgreementStore";

const prefix = "guidelines:agree:";
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
      run: (interaction) => replyEphemeral(interaction, "Agreement renewal is disabled."),
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
