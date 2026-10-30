import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { Effect } from "effect";
import { discordRequest } from "../api/request";

/** Start a private reply that can be completed later. */
export function deferEphemeral(interaction: ChatInputCommandInteraction) {
  return discordRequest(() => interaction.deferReply({ flags: MessageFlags.Ephemeral })).pipe(
    Effect.asVoid,
  );
}

/** Reply privately to an interaction that has not yet been acknowledged. */
export function replyEphemeral(interaction: ChatInputCommandInteraction, content: string) {
  return discordRequest(() => interaction.reply({ content, flags: MessageFlags.Ephemeral })).pipe(
    Effect.asVoid,
  );
}

/** Complete or update the original response; its visibility is fixed by its initial acknowledgement. */
export function editResponse(interaction: ChatInputCommandInteraction, content: string) {
  return discordRequest(() => interaction.editReply(content)).pipe(Effect.asVoid);
}

/** Resolve a deferred response or send a private error without revealing the underlying failure. */
export function notifyCommandFailure(
  interaction: ChatInputCommandInteraction,
  content = "Something went wrong while running this command. Please try again.",
) {
  return Effect.suspend(() => {
    if (interaction.replied)
      return discordRequest(() =>
        interaction.followUp({ content, flags: MessageFlags.Ephemeral }),
      ).pipe(Effect.asVoid);
    if (interaction.deferred) return editResponse(interaction, content);
    return replyEphemeral(interaction, content);
  });
}
