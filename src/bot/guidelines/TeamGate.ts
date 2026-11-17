import { ChannelType, PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import { Effect, Result } from "effect";
import { discordRequest, forEachGuildMember, roleAssignability } from "@autorole/discord-framework";
import { ConfigurationError } from "../../errors";
import { teamRoleIds } from "../commands/syncRoster";
import { guildId, officerRoleId } from "../../config/discord";
import { AgreementStore } from "./AgreementStore";

export const guidelinesChannelId = "1566875132658458675";
export const sharedTeamsCategoryId = "1565003638852550768";
export const staffRoleIds = [officerRoleId, "1550224203972870194", "1557133002285387857"];
export const teamDefinitions = [
  {
    category: "1416505110971814080",
    identity: [teamRoleIds[0], "1550242619781816403"],
    accessName: "Crimson Channel Access",
  },
  {
    category: "1547697734872604683",
    identity: [teamRoleIds[1], "1558983882798399618"],
    accessName: "White Channel Access",
  },
  {
    category: "1415400509443014768",
    identity: [teamRoleIds[2], "1566150444320035047"],
    accessName: "Black Channel Access",
  },
];
export type TeamRoles = ReadonlyArray<(typeof teamDefinitions)[number] & { access: string }>;

export const resolveTeamRoles = Effect.fn("TeamGate.resolve")(function* (guild: Guild) {
  const roles = yield* discordRequest(() => guild.roles.fetch());
  const mapping: Array<TeamRoles[number]> = [];
  for (const definition of teamDefinitions) {
    const matches = roles.filter((role) => role.name === definition.accessName);
    const access = matches.first();
    if (matches.size !== 1 || !access)
      return yield* new ConfigurationError({
        message: `Run setup:guidelines to configure ${definition.accessName}.`,
      });
    mapping.push({ ...definition, access: access.id });
  }
  return mapping;
});

export const validateTeamGate = Effect.fn("TeamGate.validate")(function* (
  guild: Guild,
  mapping: TeamRoles,
) {
  if (guild.id !== guildId)
    return yield* new ConfigurationError({
      message: "Team gate is only available in the Overwatch server.",
    });
  const roles = yield* discordRequest(() => guild.roles.fetch());
  const accessIds = new Set(mapping.map((team) => team.access));
  if (
    accessIds.size !== mapping.length ||
    mapping.some((team) => team.identity.some((id) => accessIds.has(id)))
  )
    return yield* new ConfigurationError({
      message: "Access roles must be distinct from membership roles.",
    });
  for (const { identity, access } of mapping) {
    const role = roles.get(access);
    if (
      identity.some((id) => !roles.has(id)) ||
      !role ||
      role.permissions.bitfield !== 0n ||
      (yield* roleAssignability(guild, role))
    )
      return yield* new ConfigurationError({
        message:
          "Membership roles must exist and access roles must be manageable with no server permissions.",
      });
  }
  const channels = yield* discordRequest(() => guild.channels.fetch());
  const guidelines = channels.get(guidelinesChannelId);
  if (
    !guidelines ||
    guidelines.type !== ChannelType.GuildText ||
    guidelines.parentId !== sharedTeamsCategoryId
  )
    return yield* new ConfigurationError({
      message: "The team-guidelines channel must remain in the shared Teams category.",
    });
  for (const { identity } of mapping)
    for (const id of identity)
      if (
        !guidelines
          .permissionsFor(id)
          ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
      )
        return yield* new ConfigurationError({
          message: `Membership role ${id} cannot read the guidelines.`,
        });
  for (const team of mapping) {
    const category = channels.get(team.category);
    if (!category || category.type !== ChannelType.GuildCategory)
      return yield* new ConfigurationError({
        message: `Team category ${team.category} is missing.`,
      });
    for (const channel of [
      category,
      ...channels.filter((c) => c?.parentId === category.id).values(),
    ]) {
      if (!channel || !("permissionOverwrites" in channel))
        return yield* new ConfigurationError({
          message: "Cannot inspect a team channel's permissions.",
        });
      const overwrites = channel.permissionOverwrites.cache;
      if (
        !overwrites.get(guild.id)?.deny.has(PermissionFlagsBits.ViewChannel) ||
        !overwrites.get(team.access)?.allow.has(PermissionFlagsBits.ViewChannel)
      )
        return yield* new ConfigurationError({
          message: `Channel ${channel.id} must deny everyone and allow its access role.`,
        });
      for (const overwrite of overwrites.values()) {
        if (!overwrite.allow.has(PermissionFlagsBits.ViewChannel)) continue;
        const exempt =
          overwrite.type === 0 &&
          (staffRoleIds.includes(overwrite.id) ||
            roles.get(overwrite.id)?.permissions.has(PermissionFlagsBits.Administrator));
        if (overwrite.id !== team.access && !exempt)
          return yield* new ConfigurationError({
            message: `Channel ${channel.id} has an unexpected access grant for ${overwrite.id}.`,
          });
      }
    }
  }
});

export function desiredTeamAccess(
  roles: ReadonlySet<string>,
  mapping: TeamRoles,
  accepted: boolean,
) {
  return mapping.map(({ identity, access }) => ({
    access,
    allowed: accepted && identity.some((id) => roles.has(id)),
  }));
}

const updateMemberAccess = Effect.fn("TeamGate.updateMember")(function* (
  guild: Guild,
  store: AgreementStore,
  mapping: TeamRoles,
  memberId: string,
) {
  const member = yield* discordRequest(() =>
    guild.members.fetch({ user: memberId, force: true, cache: false }),
  );
  const active = yield* store.active(guild.id);
  const accepted = !active || !!(yield* store.getAcceptance(active.id, member.id));
  const held = new Set(member.roles.cache.keys());
  let changed = false;
  for (const { access, allowed } of desiredTeamAccess(
    held,
    mapping,
    accepted && !member.user.bot,
  )) {
    if (held.has(access) === allowed) continue;
    yield* discordRequest(() =>
      allowed
        ? member.roles.add(access, "Guidelines channel access")
        : member.roles.remove(access, "Guidelines channel access"),
    );
    changed = true;
  }
  return changed;
});

export const applyTeamGate = Effect.fn("TeamGate.reconcile")(function* (
  guild: Guild,
  store: AgreementStore,
  configured?: TeamRoles,
) {
  const mapping = configured ?? (yield* resolveTeamRoles(guild));
  yield* validateTeamGate(guild, mapping);
  const members: string[] = [];
  yield* forEachGuildMember(
    guild,
    (member) =>
      Effect.sync(() => {
        if (
          mapping.some(
            (team) =>
              member.roles.cache.has(team.access) ||
              team.identity.some((id) => member.roles.cache.has(id)),
          )
        )
          members.push(member.id);
      }),
    new ConfigurationError({
      message: "Could not read all members; no access roles were changed.",
    }),
  );
  let changed = 0;
  const failed: string[] = [];
  for (const id of members) {
    const result = yield* Effect.result(updateMemberAccess(guild, store, mapping, id));
    if (Result.isFailure(result)) failed.push(id);
    else if (result.success) changed++;
  }
  return { changed, failed };
});

export const applyMemberAccess = Effect.fn("TeamGate.reconcileMember")(function* (
  member: GuildMember,
  store: AgreementStore,
) {
  if (member.guild.id !== guildId) return;
  const mapping = yield* resolveTeamRoles(member.guild);
  yield* validateTeamGate(member.guild, mapping);
  yield* updateMemberAccess(member.guild, store, mapping, member.id);
});
