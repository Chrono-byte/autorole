import { REST, Routes, type Guild } from "discord.js";
import { Effect } from "effect";
import { discordRequest } from "./request";

/** Fetch per-guild overrides for a command registered at guild or application scope. */
export const commandPermissions = Effect.fn("Discord.commandPermissions")(function* (
  guild: Guild,
  commandName: string,
  guildScoped: boolean,
) {
  const application = guild.client.application;
  if (!application) return { status: "not-ready" } as const;
  const commands = yield* discordRequest(() =>
    guildScoped ? guild.commands.fetch() : application.commands.fetch(),
  );
  const target = commands.find((command) => command.name === commandName);
  if (!target) return { status: "missing" } as const;
  const permissions = yield* discordRequest(() => guild.commands.permissions.fetch({}));
  return { status: "ok", permissions: permissions.get(target.id) ?? [] } as const;
});

/** Upsert commands individually so unrelated commands and permission overrides survive. */
export const upsertCommands = Effect.fn("Discord.upsertCommands")(function* (
  rest: REST,
  applicationId: string,
  guildId: string | undefined,
  definitions: readonly { toJSON: () => unknown }[],
) {
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);
  for (const definition of definitions)
    yield* discordRequest((signal) => rest.post(route, { body: definition.toJSON(), signal }));
});
