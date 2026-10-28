import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";
import { Effect } from "effect";
import { IntegrationSettings } from "../config/IntegrationSettings";
import { tryPromise } from "../effectful";
export class RoleService {
  constructor(private readonly settings: IntegrationSettings) {}

  private validate(guild: Guild, role: Role): Effect.Effect<void, Error> {
    return Effect.gen(function* () {
      const bot = yield* tryPromise(() => guild.members.fetchMe());
      if (!bot.permissions.has(PermissionFlagsBits.ManageRoles))
        return yield* Effect.fail(new Error("Give the bot Manage Roles permission."));
      if (role.id === guild.id || role.managed)
        return yield* Effect.fail(
          new Error("Choose a regular role, not @everyone or an integration role."),
        );
      if (bot.roles.highest.comparePositionTo(role) <= 0)
        return yield* Effect.fail(
          new Error("Move the bot's highest role above the selected role."),
        );
    });
  }

  assign(
    member: GuildMember,
    screeningComplete = false,
  ): Effect.Effect<"complete" | "pending" | "disabled", Error> {
    return Effect.gen({ self: this }, function* () {
      if (member.user.bot) return "complete";
      if (member.pending === true || (member.pending === null && !screeningComplete))
        return "pending";
      const role = yield* this.getConfiguredRole(member.guild);
      if (!role) return "disabled";
      if (member.roles.cache.has(role.id)) return "complete";
      yield* tryPromise(() => member.roles.add(role, "Automatic role after membership screening"));
      return "complete";
    });
  }

  getConfiguredRole(guild: Guild): Effect.Effect<Role | null, Error> {
    return Effect.gen({ self: this }, function* () {
      const roleId = yield* this.settings.getRoleId(guild);
      if (!roleId) return null;
      const role = yield* tryPromise(() => guild.roles.fetch(roleId));
      if (!role)
        return yield* Effect.fail(
          new Error(
            "The selected role was deleted. Select another role in Integrations > /autorole-target.",
          ),
        );
      yield* this.validate(guild, role);
      return role;
    });
  }
}
