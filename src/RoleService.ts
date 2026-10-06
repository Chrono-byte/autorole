import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from "discord.js";
import { IntegrationSettings } from "./IntegrationSettings";
export class RoleService {
  constructor(private readonly settings: IntegrationSettings) {}

  private async validate(guild: Guild, role: Role) {
    const bot = await guild.members.fetchMe();
    if (!bot.permissions.has(PermissionFlagsBits.ManageRoles))
      throw new Error("Give the bot Manage Roles permission.");
    if (role.id === guild.id || role.managed)
      throw new Error("Choose a regular role, not @everyone or an integration role.");
    if (bot.roles.highest.comparePositionTo(role) <= 0)
      throw new Error("Move the bot's highest role above the selected role.");
  }

  async assign(member: GuildMember) {
    if (member.user.bot || member.pending) return;
    const role = await this.getConfiguredRole(member.guild);
    if (!role || member.roles.cache.has(role.id)) return;
    await member.roles.add(role, "Automatic role after membership screening");
  }

  async getConfiguredRole(guild: Guild) {
    const roleId = await this.settings.getRoleId(guild);
    if (!roleId) return null;
    const role = await guild.roles.fetch(roleId);
    if (!role)
      throw new Error(
        "The selected role was deleted. Select another role in Integrations > /autorole-target.",
      );
    await this.validate(guild, role);
    return role;
  }
}
