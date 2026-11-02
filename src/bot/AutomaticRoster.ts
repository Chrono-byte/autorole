import { type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { Effect, Schedule } from "effect";
import { logError } from "../logger";
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

export function automaticRoster(client: Client) {
  const refresh = Effect.gen(function* () {
    const guild = client.guilds.cache.get(rosterGuildId);
    if (!guild) return;
    const result = yield* syncRoster(guild);
    if (result.failed) yield* logError("roster_sync_incomplete", { failed: result.failed });
  });
  return refresh.pipe(
    Effect.catch((error) => logError("roster_sync_failed", { message: error.message })),
    Effect.repeat(Schedule.spaced("5 minutes")),
    Effect.asVoid,
  );
}
