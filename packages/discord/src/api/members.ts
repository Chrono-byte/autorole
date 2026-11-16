import { type Client, type Guild, type GuildMember } from "discord.js";
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

/** Visit fresh member pages without populating the client's member cache. */
export const forEachGuildMember = Effect.fn("Discord.forEachGuildMember")(function* <E>(
  guild: Guild,
  visit: (member: GuildMember) => Effect.Effect<void, E>,
  incomplete: E,
) {
  let after: string | undefined;
  for (;;) {
    const page = yield* discordRequest(() =>
      guild.members.list({ limit: 1000, after, cache: false }),
    );
    for (const member of page.values()) yield* visit(member);
    if (page.size < 1000) return;
    const last = page.last();
    if (!last || last.id === after) return yield* Effect.fail(incomplete);
    after = last.id;
  }
});
