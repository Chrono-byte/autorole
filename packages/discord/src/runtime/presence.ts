import { ActivityType, type Client } from "discord.js";
import { Effect } from "effect";
import { type BackgroundTask } from "./background";

/** Describe supervised presence rotation, retaining the next status between passes. */
export function presenceTask(options: {
  name: string;
  statuses: readonly [string, ...string[]];
  interval: number;
}) {
  let index = 0;
  return {
    name: "presence",
    interval: options.interval,
    onFailure: "continue",
    run: (client: Client<true>) =>
      Effect.sync(() => {
        client.user.setPresence({
          activities: [
            {
              name: options.name,
              type: ActivityType.Custom,
              state: options.statuses[index] ?? options.statuses[0],
            },
          ],
          status: "online",
        });
        index = (index + 1) % options.statuses.length;
      }),
  } satisfies BackgroundTask;
}
