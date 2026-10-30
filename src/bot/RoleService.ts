import { type Guild, type GuildMember } from "discord.js";
import { Effect } from "effect";
import { roleAssignability } from "../../packages/discord/roles";
import { IntegrationSettings } from "./IntegrationSettings";
import { ConfigurationError, discordRequest } from "../errors";
export class RoleService {
  constructor(private readonly settings: IntegrationSettings) {}

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
    const problem = yield* roleAssignability(guild, role);
    const messages = {
      "missing-permission": "Give the bot Manage Roles permission.",
      "managed-role": "Choose a regular role, not @everyone or an integration role.",
      hierarchy: "Move the bot's highest role above the selected role.",
    };
    if (problem) return yield* new ConfigurationError({ message: messages[problem] });
    return role;
  });
}
