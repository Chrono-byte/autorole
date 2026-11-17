import { type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { Effect } from "effect";
import {
  playerRoleId,
  rosterGuildId,
  syncRoster,
  syncRosterMember,
  teamRoleIds,
} from "./commands/syncRoster";

const trackedRoles = [playerRoleId, ...teamRoleIds];

export function rosterChanged(before: GuildMember | PartialGuildMember, after: GuildMember) {
  return (
    after.guild.id === rosterGuildId &&
    trackedRoles.some((id) => before.roles.cache.has(id) !== after.roles.cache.has(id))
  );
}

export function automaticRosterMember(member: GuildMember) {
  return syncRosterMember(member.guild, member.id).pipe(Effect.asVoid);
}

export const refreshRoster = Effect.fn("Roster.refresh")(function* (client: Client) {
  const guild = client.guilds.cache.get(rosterGuildId);
  if (!guild) return;
  const result = yield* syncRoster(guild);
  if (result.failed)
    return yield* Effect.fail(
      new Error(`Roster synchronization incomplete: ${result.failed} member updates failed.`),
    );
});
