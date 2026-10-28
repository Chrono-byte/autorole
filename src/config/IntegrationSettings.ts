import {
  ApplicationCommandPermissionType,
  type ApplicationCommandPermissions,
  type Guild,
} from "discord.js";
import { Effect } from "effect";
import { ConfigurationError, discordRequest } from "../errors";

export class IntegrationSettings {
  constructor(private readonly guildId: string | undefined) {}

  getRoleId = Effect.fn("IntegrationSettings.getRoleId")(function* (
    this: IntegrationSettings,
    guild: Guild,
  ) {
    const guildId = this.guildId;
    if (guildId && guildId !== guild.id) return null;
    const application = guild.client.application;
    if (!application)
      return yield* Effect.fail(
        new ConfigurationError({ message: "Discord application is not ready." }),
      );
    const commands = yield* discordRequest(() =>
      guildId ? guild.commands.fetch() : application.commands.fetch(),
    );
    const target = commands.find((command) => command.name === "autorole-target");
    if (!target)
      return yield* Effect.fail(
        new ConfigurationError({ message: "Run bun run register to register /autorole-target." }),
      );
    const permissions = yield* discordRequest(() => guild.commands.permissions.fetch({}));
    return yield* IntegrationSettings.selectRole(guild.id, permissions.get(target.id) ?? []);
  });

  private static selectRole(
    guildId: string,
    permissions: readonly ApplicationCommandPermissions[],
  ) {
    const roleIds = new Set(
      permissions
        .filter(
          (entry) =>
            entry.type === ApplicationCommandPermissionType.Role &&
            entry.permission &&
            entry.id !== guildId,
        )
        .map((entry) => entry.id),
    );
    if (roleIds.size > 1) {
      return Effect.fail(
        new ConfigurationError({
          message:
            "Allow exactly one role on /autorole-target in Server Settings > Integrations. Multiple allowed roles disable assignment.",
        }),
      );
    }
    return Effect.succeed(roleIds.values().next().value ?? null);
  }
}
