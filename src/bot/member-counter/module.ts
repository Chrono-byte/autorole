import { type Client } from "discord.js";
import { Effect } from "effect";
import { type BotModule } from "@autorole/discord-framework";
import { featureStatePath, type BotFeature, type BotOptions } from "../feature";
import { StatsStore } from "./StatsStore";
import { serverStatsCommands } from "./ServerStatsCommand";
import { refreshMemberCounters } from "./ServerStats";

export const memberCounterFeature = {
  definitions: serverStatsCommands.definitions,
  make: Effect.fn("MemberCounter.module")(function* (client: Client, options: BotOptions) {
    const store = yield* StatsStore.make(featureStatePath(options.path, "stats"));
    return {
      commands: serverStatsCommands.bind(store),
      events: [],
      background: [
        {
          name: "member-counter",
          interval: "10 minutes",
          timeout: "5 minutes",
          onFailure: "continue",
          run: () => refreshMemberCounters(client, store),
        },
      ],
    } satisfies BotModule;
  }),
} satisfies BotFeature;
