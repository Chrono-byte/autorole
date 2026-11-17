import { Events, GatewayIntentBits, PermissionFlagsBits, type Guild } from "discord.js";
import { Deferred, Effect } from "effect";
import {
  discordRequest,
  forEachGuildMember,
  listen,
  runClient,
  roleAssignability,
} from "@autorole/discord-framework";
import { readConfiguration } from "../config/Configuration";
import { runMain } from "../runMain";
import { ConfigurationError } from "../errors";
import { guildId } from "../config/discord";
import {
  teamDefinitions,
  staffRoleIds,
  sharedTeamsCategoryId,
  resolveTeamRoles,
  validateTeamGate,
} from "../bot/guidelines/TeamGate";

export const setupGuidelines = Effect.fn("Guidelines.setup")(function* (
  guild: Guild,
  checkOnly: boolean,
) {
  if (checkOnly) {
    yield* validateTeamGate(guild, yield* resolveTeamRoles(guild));
    return { rolesCreated: 0, assignments: 0, overwrites: 0 };
  }
  if (guild.id !== guildId)
    return yield* new ConfigurationError({
      message: "Guidelines setup is only available in the Overwatch server.",
    });
  const roles = yield* discordRequest(() => guild.roles.fetch());
  const channels = yield* discordRequest(() => guild.channels.fetch());
  const view = PermissionFlagsBits.ViewChannel;
  const migrating = new Set<string>();
  for (const team of teamDefinitions) {
    const category = channels.get(team.category);
    if (!category || team.identity.some((id) => !roles.has(id)))
      return yield* new ConfigurationError({
        message: `Team membership or category for ${team.accessName} is missing.`,
      });
    const matches = roles.filter((role) => role.name === team.accessName);
    const existing = matches.first();
    if (
      matches.size > 1 ||
      (existing &&
        (existing.permissions.bitfield !== 0n || (yield* roleAssignability(guild, existing))))
    )
      return yield* new ConfigurationError({
        message: `Review existing ${team.accessName} roles before setup.`,
      });
    for (const channel of [
      category,
      ...channels.filter((c) => c?.parentId === team.category).values(),
    ]) {
      if (!channel || !("permissionOverwrites" in channel))
        return yield* new ConfigurationError({ message: "Cannot inspect a team channel." });
      if (!channel.permissionOverwrites.cache.get(guild.id)?.deny.has(view))
        return yield* new ConfigurationError({
          message: `Channel ${channel.id} must deny View Channel to everyone.`,
        });
      for (const overwrite of channel.permissionOverwrites.cache.values()) {
        if (!overwrite.allow.has(view)) continue;
        if (team.identity.includes(overwrite.id)) {
          migrating.add(team.category);
          continue;
        }
        if (
          overwrite.type === 0 &&
          (staffRoleIds.includes(overwrite.id) ||
            matches.has(overwrite.id) ||
            roles.get(overwrite.id)?.permissions.has(PermissionFlagsBits.Administrator))
        )
          continue;
        return yield* new ConfigurationError({
          message: `Review unexpected access grant ${overwrite.id} in ${channel.id} before setup.`,
        });
      }
    }
  }
  const members: string[] = [];
  yield* forEachGuildMember(
    guild,
    (member) =>
      Effect.sync(() => {
        if (!member.user.bot) members.push(member.id);
      }),
    new ConfigurationError({ message: "Could not scan all members; no permissions were changed." }),
  );
  let rolesCreated = 0;
  for (const team of teamDefinitions) {
    if (!roles.some((role) => role.name === team.accessName)) {
      yield* discordRequest(() =>
        guild.roles.create({
          name: team.accessName,
          permissions: 0n,
          mentionable: false,
          hoist: false,
          reason: "Separate team membership from agreement channel access",
        }),
      );
      rolesCreated++;
    }
  }
  const mapping = yield* resolveTeamRoles(guild);
  let assignments = 0;
  for (const id of members) {
    const member = yield* discordRequest(() =>
      guild.members.fetch({ user: id, force: true, cache: false }),
    );
    for (const team of mapping) {
      if (
        migrating.has(team.category) &&
        team.identity.some((role) => member.roles.cache.has(role)) &&
        !member.roles.cache.has(team.access)
      ) {
        yield* discordRequest(() =>
          member.roles.add(team.access, "Preserve access during guidelines migration"),
        );
        const verified = yield* discordRequest(() =>
          guild.members.fetch({ user: id, force: true, cache: false }),
        );
        if (!verified.roles.cache.has(team.access))
          return yield* new ConfigurationError({
            message: "Could not verify access role assignment; channel migration stopped.",
          });
        assignments++;
      }
    }
  }
  let overwrites = 0;
  for (const team of mapping) {
    for (const channel of channels
      .filter((c) => c?.id === team.category || c?.parentId === team.category)
      .values()) {
      if (!channel || !("permissionOverwrites" in channel)) continue;
      yield* discordRequest(() =>
        channel.permissionOverwrites.edit(
          team.access,
          { ViewChannel: true, Connect: true },
          { reason: "Agreement-controlled team channel access" },
        ),
      );
      for (const id of team.identity) {
        const prior = channel.permissionOverwrites.cache.get(id);
        if (
          prior &&
          (prior.allow.bitfield | prior.deny.bitfield) & (view | PermissionFlagsBits.Connect)
        ) {
          yield* discordRequest(() =>
            channel.permissionOverwrites.edit(
              id,
              { ViewChannel: null, Connect: null },
              { reason: "Membership remains independent of channel access" },
            ),
          );
        }
      }
      overwrites++;
    }
  }
  for (const channel of channels
    .filter((c) => c?.id === sharedTeamsCategoryId || c?.parentId === sharedTeamsCategoryId)
    .values()) {
    if (!channel || !("permissionOverwrites" in channel)) continue;
    for (const team of mapping)
      for (const id of team.identity)
        yield* discordRequest(() =>
          channel.permissionOverwrites.edit(
            id,
            { ViewChannel: true, ReadMessageHistory: true },
            { reason: "Members and substitutes must be able to read and accept guidelines" },
          ),
        );
  }
  yield* validateTeamGate(guild, yield* resolveTeamRoles(guild));
  return { rolesCreated, assignments, overwrites };
});

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
      return yield* new ConfigurationError({
        message: "Usage: bun run setup:guidelines [--check]",
      });
    const config = yield* readConfiguration();
    const done = yield* Deferred.make<void, Error>();
    yield* runClient(
      { intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] },
      config.token,
      (client) =>
        listen(
          client,
          Events.ClientReady,
          () =>
            Effect.gen(function* () {
              const guild = yield* discordRequest(() => client.guilds.fetch(guildId));
              const result = yield* setupGuidelines(guild, args[0] === "--check");
              yield* Effect.sync(() => process.stdout.write(`${JSON.stringify(result)}\n`));
              yield* Deferred.succeed(done, undefined);
            }),
          (error) => Deferred.fail(done, error).pipe(Effect.asVoid),
          true,
        ),
      Deferred.await(done),
    );
  });
  await runMain(program, "guidelines_setup_failed");
}
