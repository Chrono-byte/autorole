import { ActivityType, type Client } from "discord.js";
import { Effect, Schedule } from "effect";

/** Rotate a ready client's custom status immediately and then at the given interval. */
export function rotatePresence(
  client: Client<true>,
  name: string,
  statuses: readonly [string, ...string[]],
  interval: number,
) {
  let index = 0;
  return Effect.sync(() => {
    client.user.setPresence({
      activities: [{ name, type: ActivityType.Custom, state: statuses[index] ?? statuses[0] }],
      status: "online",
    });
    index = (index + 1) % statuses.length;
  }).pipe(Effect.repeat(Schedule.spaced(interval)), Effect.asVoid);
}
