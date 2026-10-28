import {
  ApplicationCommandPermissionType,
  type ApplicationCommandPermissions,
  type Guild,
} from "discord.js";
import { Effect } from "effect";
import { tryPromise, trySync } from "../effectful";

export class IntegrationSettings {
  constructor(private readonly guildId: string | undefined) {}

  getRoleId(guild: Guild): Effect.Effect<string | null, Error> {
    const guildId = this.guildId;
    return Effect.gen(function* () {
      if (guildId && guildId !== guild.id) return null;
      const application = guild.client.application;
      if (!application) return yield* Effect.fail(new Error("Discord application is not ready."));
      const commands = yield* tryPromise(() =>
        guildId ? guild.commands.fetch() : application.commands.fetch(),
      );
      const target = commands.find((command) => command.name === "autorole-target");
      if (!target)
        return yield* Effect.fail(new Error("Run bun run register to register /autorole-target."));
      const permissions = yield* tryPromise(() => guild.commands.permissions.fetch({}));
      return yield* trySync(() =>
        IntegrationSettings.selectRole(guild.id, permissions.get(target.id) ?? []),
      );
    });
  }

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
      throw new Error(
        "Allow exactly one role on /autorole-target in Server Settings > Integrations. Multiple allowed roles disable assignment.",
      );
    }
    return roleIds.values().next().value ?? null;
  }
}
