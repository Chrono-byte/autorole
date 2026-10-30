import { type Client } from "discord.js";
import { Effect } from "effect";
import { DiscordRequestError, discordRequest } from "./request";

/** Fetch a fresh guild member, treating a missing or unavailable cached guild as a retryable DiscordRequestError. */
export const fetchGuildMember = Effect.fn("fetchGuildMember")(function* (
  client: Client,
  guildId: string,
  memberId: string,
) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild || guild.available === false)
    return yield* new DiscordRequestError({
      message: "Guild is unavailable",
      cause: new Error("Guild is unavailable"),
      retryable: true,
    });
  return yield* discordRequest(() => guild.members.fetch({ user: memberId, force: true }));
});
