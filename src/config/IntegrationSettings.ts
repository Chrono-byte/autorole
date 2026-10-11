import {
  ApplicationCommandPermissionType,
  type ApplicationCommandPermissions,
  type Guild,
} from "discord.js";

export class IntegrationSettings {
  constructor(private readonly guildId: string | undefined) {}

  async getRoleId(guild: Guild) {
    if (this.guildId && this.guildId !== guild.id) return null;
    const application = guild.client.application;
    if (!application) throw new Error("Discord application is not ready.");
    const commands = this.guildId
      ? await guild.commands.fetch()
      : await application.commands.fetch();
    const target = commands.find((command) => command.name === "autorole-target");
    if (!target) throw new Error("Run bun run register to register /autorole-target.");
    const permissions = await guild.commands.permissions.fetch({});
    return IntegrationSettings.selectRole(guild.id, permissions.get(target.id) ?? []);
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
