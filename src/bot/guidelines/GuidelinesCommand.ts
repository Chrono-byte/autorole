import {
  ApplicationIntegrationType,
  AttachmentBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
} from "discord.js";
import { Effect, Result } from "effect";
import {
  CommandCatalog,
  deferEphemeral,
  forEachGuildMember,
  editResponse,
  replyEphemeral,
} from "@autorole/discord-framework";
import { teamRolesFromEnv } from "./TeamGate";
import { rosterGuildId } from "../commands/syncRoster";
import { AgreementStore } from "./AgreementStore";

const prefix = "guidelines:agree:";
const guidelinesDefinition = new SlashCommandBuilder()
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

const guidelinesStatusDefinition = new SlashCommandBuilder()
  .setName("guidelines-status")
  .setDescription("Check outstanding agreements or a member's history")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addUserOption((o) => o.setName("member").setDescription("Show this member's agreement history"));

export const guidelinesCommands = new CommandCatalog<AgreementStore>([
  {
    definition: guidelinesDefinition,
    permissions: { guildOnly: true, member: PermissionFlagsBits.ManageGuild },
    run: (_, interaction) => replyEphemeral(interaction, "Agreement renewal is disabled."),
  },
  {
    definition: guidelinesStatusDefinition,
    permissions: { guildOnly: true, member: PermissionFlagsBits.ManageGuild },
    run: (store, interaction) =>
      Effect.gen(function* () {
        const guild = interaction.guild;
        if (!guild)
          return yield* replyEphemeral(
            interaction,
            "Agreement records are only available in a server.",
          );
        yield* deferEphemeral(interaction);
        const active = yield* store.active(guild.id);
        const member = interaction.options.getUser("member");
        if (member) {
          const history = yield* store.history(guild.id, member.id);
          const lines = history.map(
            (h) => `${h.period} (version ${h.version}): <t:${Math.floor(h.agreedAt / 1000)}:f>`,
          );
          const acceptance = active ? yield* store.getAcceptance(active.id, member.id) : null;
          const current = active
            ? `${active.period} (version ${active.version}): ${acceptance ? `Agreed <t:${Math.floor(acceptance.agreedAt / 1000)}:f>` : "Not yet agreed"}.`
            : "No active agreement period.";
          const report = `Agreement history for ${member.id}:\n${current}\n\n${lines.join("\n") || "No recorded agreements."}`;
          return yield* editResponse(
            interaction,
            report.length <= 2000
              ? report
              : {
                  content: `Agreement history for ${member.id}:\n${current}\nFull history attached.`,
                  files: [
                    new AttachmentBuilder(Buffer.from(report), { name: "agreement-history.txt" }),
                  ],
                },
          );
        }
        if (!active) return yield* editResponse(interaction, "No active agreement period.");
        const mapping = guild.id === rosterGuildId ? teamRolesFromEnv() : null;
        if (!mapping)
          return yield* editResponse(
            interaction,
            "Team roles are not configured. Select a member to inspect their agreement history.",
          );
        const missing: string[] = [];
        const agreed: string[] = [];
        const incomplete = new Error("Could not read all members; status is incomplete.");
        const scanned = yield* Effect.result(
          forEachGuildMember(
            guild,
            (entry) =>
              Effect.gen(function* () {
                if (
                  entry.user.bot ||
                  !mapping.some((x) => x.identity.some((id) => entry.roles.cache.has(id)))
                )
                  return;
                const acceptance = yield* store.getAcceptance(active.id, entry.id);
                if (acceptance)
                  agreed.push(`${entry.id}: ${new Date(acceptance.agreedAt).toISOString()}`);
                else missing.push(entry.id);
              }),
            incomplete,
          ),
        );
        if (Result.isFailure(scanned)) {
          if (scanned.failure === incomplete)
            return yield* editResponse(interaction, incomplete.message);
          return yield* Effect.fail(scanned.failure);
        }
        const summary = `${active.period} (version ${active.version}): ${agreed.length} agreed, ${missing.length} outstanding among current team members.`;
        const report = `${summary}\n\nAgreed (member ID and date in UTC):\n${agreed.join("\n") || "None."}\n\nOutstanding (member IDs):\n${missing.join("\n") || "None."}`;
        return yield* editResponse(interaction, {
          content: summary,
          files: [new AttachmentBuilder(Buffer.from(report), { name: "agreement-status.txt" })],
        });
      }),
  },
]);

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
