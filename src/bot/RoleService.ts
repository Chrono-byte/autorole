import { ApplicationCommandPermissionType, type Guild, type GuildMember } from "discord.js";
import { Effect } from "effect";
import { commandPermissions } from "../../packages/discord/commands";
import { roleAssignability } from "../../packages/discord/roles";
import { ConfigurationError, discordRequest } from "../errors";
export class RoleService {
  constructor(private readonly guildId?: string) {}

  assign = Effect.fn("RoleService.assign")(function* (
    this: RoleService,
    member: GuildMember,
    screeningComplete = false,
  ) {
    if (member.user.bot) return "complete";
    if (member.pending === true || (member.pending === null && !screeningComplete))
      return "pending";
    const role = yield* this.getConfiguredRole(member.guild);
    if (!role) return "disabled";
    if (member.roles.cache.has(role.id)) return "complete";
    yield* discordRequest(() =>
      member.roles.add(role, "Automatic role after membership screening"),
    );
    return "complete";
  });

  getConfiguredRole = Effect.fn("RoleService.getConfiguredRole")(function* (
    this: RoleService,
    guild: Guild,
  ) {
    const roleId = yield* this.getRoleId(guild);
    if (!roleId) return null;
    const role = yield* discordRequest(() => guild.roles.fetch(roleId));
    if (!role)
      return yield* Effect.fail(
        new ConfigurationError({
          message:
            "The selected role was deleted. Select another role in Integrations > /autorole-target.",
        }),
      );
    const problem = yield* roleAssignability(guild, role);
    const messages = {
      "missing-permission": "Give the bot Manage Roles permission.",
      "managed-role": "Choose a regular role, not @everyone or an integration role.",
      hierarchy: "Move the bot's highest role above the selected role.",
    };
    if (problem) return yield* new ConfigurationError({ message: messages[problem] });
    return role;
  });

  private getRoleId = Effect.fn("RoleService.getRoleId")(function* (
    this: RoleService,
    guild: Guild,
  ) {
    if (this.guildId && this.guildId !== guild.id) return null;
    const result = yield* commandPermissions(guild, "autorole-target", !!this.guildId);
    if (result.status === "not-ready")
      return yield* new ConfigurationError({ message: "Discord application is not ready." });
    if (result.status === "missing")
      return yield* new ConfigurationError({
        message: "Run bun run register to register /autorole-target.",
      });
    const roleIds = new Set(
      result.permissions
        .filter(
          (entry) =>
            entry.type === ApplicationCommandPermissionType.Role &&
            entry.permission &&
            entry.id !== guild.id,
        )
        .map((entry) => entry.id),
    );
    if (roleIds.size > 1)
      return yield* new ConfigurationError({
        message:
          "Allow exactly one role on /autorole-target in Server Settings > Integrations. Multiple allowed roles disable assignment.",
      });
    return roleIds.values().next().value ?? null;
  });
}
