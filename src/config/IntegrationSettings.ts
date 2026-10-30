import {
  ApplicationCommandPermissionType,
  type ApplicationCommandPermissions,
  type Guild,
} from "discord.js";
import { Effect } from "effect";
import { commandPermissions } from "../../packages/discord/commands";
import { ConfigurationError } from "../errors";

export class IntegrationSettings {
  constructor(private readonly guildId: string | undefined) {}

  getRoleId = Effect.fn("IntegrationSettings.getRoleId")(function* (
    this: IntegrationSettings,
    guild: Guild,
  ) {
    const guildId = this.guildId;
    if (guildId && guildId !== guild.id) return null;
    const result = yield* commandPermissions(guild, "autorole-target", !!guildId);
    if (result.status === "not-ready")
      return yield* new ConfigurationError({ message: "Discord application is not ready." });
    if (result.status === "missing")
      return yield* new ConfigurationError({
        message: "Run bun run register to register /autorole-target.",
      });
    return yield* IntegrationSettings.selectRole(guild.id, result.permissions);
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
