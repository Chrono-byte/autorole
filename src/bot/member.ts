import { type Guild } from "discord.js";
import { discordRequest } from "@autorole/discord-framework";

export const fetchCurrentMember = (guild: Guild, user: string) =>
  discordRequest(() => guild.members.fetch({ user, force: true, cache: false }));
