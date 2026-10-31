import { type Guild } from "discord.js";
import { Effect, Result } from "effect";
import { discordRequest, roleAssignability } from "@autorole/discord-framework";
import { ConfigurationError } from "../../errors";

export const rosterGuildId = "1415400507006124093";
export const playerRoleId = "1424545955826634915";
export const teamRoleIds = [
  "1415400507006124095",
  "1547640814732054528",
  "1415400507006124096",
] as const;

export const syncRoster = Effect.fn("Roster.sync")(function* (guild: Guild, actorId: string) {
  if (guild.id !== rosterGuildId)
    return yield* new ConfigurationError({
      message: "This command is only available in Overwatch Esports at IUI.",
    });

  const roles = yield* discordRequest(() => guild.roles.fetch());
  const playerRole = roles.get(playerRoleId);
  if (!playerRole || teamRoleIds.some((id) => !roles.has(id)))
    return yield* new ConfigurationError({
      message: "A required Player or team role is missing; no changes were made.",
    });
  const problem = yield* roleAssignability(guild, playerRole);
  if (problem)
    return yield* new ConfigurationError({
      message:
        problem === "hierarchy"
          ? "Move the bot's highest role above Player."
          : "The bot cannot manage the Player role.",
    });
  if (actorId !== guild.ownerId) {
    const actor = yield* discordRequest(() => guild.members.fetch({ user: actorId, force: true }));
    if (actor.roles.highest.comparePositionTo(playerRole) <= 0)
      return yield* new ConfigurationError({ message: "Your highest role must be above Player." });
  }

  const changes: { id: string; add: boolean }[] = [];
  let after: string | undefined;
  for (;;) {
    const page = yield* discordRequest(() =>
      guild.members.list({ limit: 1000, after, cache: false }),
    );
    for (const member of page.values()) {
      const hasPlayer = member.roles.cache.has(playerRoleId);
      const hasTeam = teamRoleIds.some((id) => member.roles.cache.has(id));
      if (hasPlayer !== hasTeam) changes.push({ id: member.id, add: hasTeam });
    }
    if (page.size < 1000) break;
    const last = page.last();
    if (!last || last.id === after)
      return yield* new ConfigurationError({
        message: "Could not read the complete member list; no changes were made.",
      });
    after = last.id;
  }

  let added = 0;
  let removed = 0;
  let failed = 0;
  for (const change of changes) {
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const member = yield* discordRequest(() =>
          guild.members.fetch({ user: change.id, force: true, cache: false }),
        );
        const hasPlayer = member.roles.cache.has(playerRoleId);
        const hasTeam = teamRoleIds.some((id) => member.roles.cache.has(id));
        if (hasPlayer === hasTeam) return "unchanged" as const;
        if (hasTeam) {
          yield* discordRequest(() => member.roles.add(playerRoleId, `Roster sync by ${actorId}`));
          return "added" as const;
        }
        yield* discordRequest(() => member.roles.remove(playerRoleId, `Roster sync by ${actorId}`));
        return "removed" as const;
      }),
    );
    if (Result.isFailure(result)) failed++;
    else if (result.success === "added") added++;
    else if (result.success === "removed") removed++;
  }
  return { added, removed, failed };
});
