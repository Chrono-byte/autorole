import { type ChatInputCommandInteraction, type PermissionResolvable } from "discord.js";
import { Effect, Schema } from "effect";

/** Execution-time requirements; command registration defaults do not enforce these checks. */
export type CommandPermissions = {
  guildOnly?: boolean;
  member?: PermissionResolvable;
  bot?: PermissionResolvable;
  deniedMessage?: string;
};

export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()("PermissionDenied", {
  message: Schema.String,
  reason: Schema.Literals(["guild", "member", "bot"]),
}) {}

/** Check the invoking member and bot's permissions for the interaction's current context. */
export const checkPermissions = Effect.fn("Discord.checkPermissions")(function* (
  interaction: ChatInputCommandInteraction,
  requirements: CommandPermissions,
) {
  const deny = (reason: "guild" | "member" | "bot", fallback: string) =>
    new PermissionDenied({ reason, message: requirements.deniedMessage ?? fallback });
  if (requirements.guildOnly && !interaction.guildId)
    return yield* deny("guild", "This command can only be used in a server.");
  if (requirements.member !== undefined && !interaction.memberPermissions?.has(requirements.member))
    return yield* deny("member", "You do not have permission to use this command.");
  if (requirements.bot !== undefined && !interaction.appPermissions?.has(requirements.bot))
    return yield* deny("bot", "The bot does not have the permissions required for this command.");
});
