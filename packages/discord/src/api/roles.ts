import { PermissionFlagsBits, type Guild, type Role } from "discord.js";
import { Effect } from "effect";
import { discordRequest } from "./request";

/** Return the first Discord constraint preventing the bot from assigning a role. */
export const roleAssignability = Effect.fn("Discord.roleAssignability")(function* (
  guild: Guild,
  role: Role,
) {
  const bot = yield* discordRequest(() => guild.members.fetchMe());
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) return "missing-permission";
  if (role.id === guild.id || role.managed) return "managed-role";
  if (bot.roles.highest.comparePositionTo(role) <= 0) return "hierarchy";
  return null;
});
