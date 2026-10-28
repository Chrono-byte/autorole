import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";
import { Effect } from "effect";
import { IntegrationSettings } from "../config/IntegrationSettings";
import { ConfigurationError, discordRequest } from "../errors";
export class RoleService {
  constructor(private readonly settings: IntegrationSettings) {}

  private validate = Effect.fn("RoleService.validate")(function* (
    this: RoleService,
    guild: Guild,
    role: Role,
  ) {
    const bot = yield* discordRequest(() => guild.members.fetchMe());
    if (!bot.permissions.has(PermissionFlagsBits.ManageRoles))
      return yield* Effect.fail(
        new ConfigurationError({ message: "Give the bot Manage Roles permission." }),
      );
    if (role.id === guild.id || role.managed)
      return yield* Effect.fail(
        new ConfigurationError({
          message: "Choose a regular role, not @everyone or an integration role.",
        }),
      );
    if (bot.roles.highest.comparePositionTo(role) <= 0)
      return yield* Effect.fail(
        new ConfigurationError({ message: "Move the bot's highest role above the selected role." }),
      );
  });

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
    const roleId = yield* this.settings.getRoleId(guild);
    if (!roleId) return null;
    const role = yield* discordRequest(() => guild.roles.fetch(roleId));
    if (!role)
      return yield* Effect.fail(
        new ConfigurationError({
          message:
            "The selected role was deleted. Select another role in Integrations > /autorole-target.",
        }),
      );
    yield* this.validate(guild, role);
    return role;
  });
}
