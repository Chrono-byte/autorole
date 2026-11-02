import { ChannelType, PermissionFlagsBits, type Client, type Guild } from "discord.js";
import { Effect, Result, Schedule } from "effect";
import { discordRequest, roleAssignability } from "@autorole/discord-framework";
import { ConfigurationError } from "../../errors";
import { logError } from "../../logger";
import { rosterGuildId, teamRoleIds } from "../commands/syncRoster";
import { AgreementStore } from "./AgreementStore";

const categories = ["1416505110971814080", "1547697734872604683", "1415400509443014768"];
const sharedCategory = "1565003638852550768";
export type TeamRoles = ReadonlyArray<{
  category: string;
  identity: readonly string[];
  team: string;
  pending: string;
}>;

export function teamRolesFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const ids = [
    env.GUIDELINES_PENDING_CRIMSON,
    env.GUIDELINES_PENDING_WHITE,
    env.GUIDELINES_PENDING_BLACK,
  ].map((value) => value?.trim());
  if (ids.every((value) => !value)) {
    ids[0] = "1566921143695319230";
    ids[1] = "1566921148753514516";
    ids[2] = "1566921154277671122";
  }
  if (
    ids.some((value) => !value || !/^\d{17,20}$/.test(value)) ||
    new Set([...ids, ...teamRoleIds]).size !== 6
  )
    throw new Error("Set three distinct GUIDELINES_PENDING_* role IDs.");
  return teamRoleIds.map((team, index) => ({
    category: categories[index]!,
    team,
    pending: ids[index]!,
    identity: [team, ids[index]!],
  }));
}

export const validateTeamGate = Effect.fn("TeamGate.validate")(function* (
  guild: Guild,
  mapping: TeamRoles,
) {
  if (guild.id !== rosterGuildId)
    return yield* new ConfigurationError({
      message: "Team gate is only available in the Overwatch server.",
    });
  const roles = yield* discordRequest(() => guild.roles.fetch());
  const teamIds = new Set(mapping.map((x) => x.team));
  const pendingIds = new Set(mapping.map((x) => x.pending));
  if (
    teamIds.size !== mapping.length ||
    pendingIds.size !== mapping.length ||
    [...pendingIds].some((id) => teamIds.has(id))
  )
    return yield* new ConfigurationError({ message: "Team and pending roles must be distinct." });
  for (const id of [...teamIds, ...pendingIds]) {
    const role = roles.get(id);
    if (!role || (yield* roleAssignability(guild, role)))
      return yield* new ConfigurationError({
        message: "Each team and pending role must exist and be manageable by the bot.",
      });
    if (pendingIds.has(id) && role.permissions.bitfield !== 0n)
      return yield* new ConfigurationError({
        message: "Pending roles must have no server permissions.",
      });
  }
  const channels = yield* discordRequest(() => guild.channels.fetch());
  const shared = channels.get(sharedCategory);
  if (!shared || shared.type !== ChannelType.GuildCategory)
    return yield* new ConfigurationError({ message: "The shared Teams category is missing." });
  for (const channel of [
    shared,
    ...channels.filter((c) => c?.parentId === sharedCategory).values(),
  ]) {
    if (!channel || !("permissionsFor" in channel))
      return yield* new ConfigurationError({
        message: "Cannot inspect shared Teams channel permissions.",
      });
    for (const id of pendingIds)
      if (!channel.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel))
        return yield* new ConfigurationError({
          message: `Pending role ${id} cannot view shared channel ${channel.id}.`,
        });
  }
  const direct = new Set<string>();
  const bypassRoles = new Set<string>();
  for (const { category, team } of mapping) {
    const parent = channels.get(category);
    if (!parent || parent.type !== ChannelType.GuildCategory)
      return yield* new ConfigurationError({ message: `Team category ${category} is missing.` });
    for (const channel of [parent, ...channels.filter((c) => c?.parentId === category).values()]) {
      if (!channel || !("permissionOverwrites" in channel))
        return yield* new ConfigurationError({
          message: "Cannot inspect a team channel's permissions.",
        });
      const overwrites = channel.permissionOverwrites.cache;
      if (
        !overwrites.get(guild.id)?.deny.has(PermissionFlagsBits.ViewChannel) ||
        !overwrites.get(team)?.allow.has(PermissionFlagsBits.ViewChannel)
      )
        return yield* new ConfigurationError({
          message: `Channel ${channel.id} must deny everyone and allow its team role.`,
        });
      for (const id of pendingIds)
        if (channel.permissionsFor(id)?.has(PermissionFlagsBits.ViewChannel))
          return yield* new ConfigurationError({
            message: `Pending role ${id} can view team channel ${channel.id}.`,
          });
      for (const overwrite of overwrites.values()) {
        if (!overwrite.allow.has(PermissionFlagsBits.ViewChannel)) continue;
        if (overwrite.type === 1) direct.add(overwrite.id);
        else if (
          !teamIds.has(overwrite.id) &&
          !roles.get(overwrite.id)?.permissions.has(PermissionFlagsBits.Administrator)
        )
          bypassRoles.add(overwrite.id);
      }
    }
  }
  return { direct, bypassRoles };
});

export const reconcileTeamGate = Effect.fn("TeamGate.reconcile")(function* (
  guild: Guild,
  store: AgreementStore,
  mapping: TeamRoles,
) {
  const active = yield* store.active(guild.id);
  if (!active) return { changed: 0, failed: [] as string[], conflicts: [] as string[] };
  const { direct, bypassRoles } = yield* validateTeamGate(guild, mapping);
  const members: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = yield* discordRequest(() =>
      guild.members.list({ limit: 1000, after, cache: false }),
    );
    for (const member of page.values())
      if (
        mapping.some(
          ({ team, pending }) => member.roles.cache.has(team) || member.roles.cache.has(pending),
        ) ||
        direct.has(member.id) ||
        [...bypassRoles].some((id) => member.roles.cache.has(id))
      )
        members.push(member.id);
    if (page.size < 1000) break;
    const last = page.last();
    if (!last || last.id === after)
      return yield* new ConfigurationError({
        message: "Could not read all members; no team roles were changed.",
      });
    after = last.id;
  }
  let changed = 0;
  const failed: string[] = [],
    conflicts: string[] = [];
  for (const id of members) {
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const current = yield* store.active(guild.id);
        if (!current || current.id !== active.id) return { changed: false, conflict: false };
        const member = yield* discordRequest(() =>
          guild.members.fetch({ user: id, force: true, cache: false }),
        );
        const accepted = !!(yield* store.getAcceptance(active.id, id));
        const admin =
          member.id === guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);
        let updated = false;
        for (const { team, pending } of mapping) {
          if (!member.roles.cache.has(team) && !member.roles.cache.has(pending)) continue;
          const add = accepted ? team : pending;
          const remove = accepted ? pending : team;
          if (!member.roles.cache.has(add)) {
            yield* discordRequest(() => member.roles.add(add, "Guidelines agreement gate"));
            updated = true;
          }
          if (member.roles.cache.has(remove)) {
            yield* discordRequest(() => member.roles.remove(remove, "Guidelines agreement gate"));
            updated = true;
          }
        }
        return {
          changed: updated,
          conflict:
            !accepted &&
            !admin &&
            (direct.has(id) || [...bypassRoles].some((role) => member.roles.cache.has(role))),
        };
      }),
    );
    if (Result.isFailure(result)) failed.push(id);
    else {
      if (result.success.changed) changed++;
      if (result.success.conflict) conflicts.push(id);
    }
  }
  return { changed, failed, conflicts };
});

export function automaticTeamGate(client: Client, store: AgreementStore, mapping: TeamRoles) {
  const refresh = Effect.gen(function* () {
    const guild = client.guilds.cache.get(rosterGuildId);
    if (!guild) return;
    const result = yield* reconcileTeamGate(guild, store, mapping);
    if (result.failed.length || result.conflicts.length)
      yield* logError("guidelines_gate_incomplete", {
        failed: result.failed.join(","),
        conflicts: result.conflicts.join(","),
      });
  });
  return refresh.pipe(
    Effect.catch((error) => logError("guidelines_gate_failed", { message: error.message })),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.asVoid,
  );
}
