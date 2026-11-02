import { type Client } from "discord.js";
import { Effect, Schedule } from "effect";
import { discordRequest } from "@autorole/discord-framework";
import { logError } from "../logger";
import { StatsStore } from "./StatsStore";

export function refreshServerStats(client: Client, guildId: string, channelId: string) {
  return Effect.gen(function* () {
    const guild = yield* discordRequest(() => client.guilds.fetch(guildId));
    const members = yield* discordRequest(() => guild.members.fetch());
    const humanCount = members.filter((member) => !member.user.bot).size;
    const channel = yield* discordRequest(() => guild.channels.fetch(channelId));
    if (!channel) return yield* Effect.fail(new Error("Stats channel not found"));
    const name = `Members: ${humanCount}`;
    if (channel.name !== name) {
      yield* discordRequest(async () => {
        await channel.setName(name);
      });
    }
  });
}

export function serverMemberCounter(client: Client, store: StatsStore) {
  const refresh = Effect.gen(function* () {
    const settings = yield* store.list();
    for (const setting of settings) {
      yield* refreshServerStats(client, setting.guildId, setting.channelId).pipe(
        Effect.catch((error) =>
          logError("server_stats_refresh_failed", {
            guildId: setting.guildId,
            message: error.message,
          }),
        ),
      );
    }
  });
  return refresh.pipe(
    Effect.catch((error) => logError("server_stats_store_failed", { message: error.message })),
    Effect.repeat(Schedule.spaced("10 minutes")),
    Effect.asVoid,
  );
}
