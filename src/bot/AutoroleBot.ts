import { GatewayIntentBits } from "discord.js";
import { Effect } from "effect";
import { runBot } from "@autorole/discord-framework";
import { makeAutorole } from "./module";
import { asError } from "../effectful";
import { DiscordRequestError } from "../errors";
import { type Configuration } from "../config/Configuration";
import { logError, logInfo } from "../logger";
import { notifyReady } from "./notifyReady";

const MINUTE_MS = 60_000;
const reportHandler = (error: Error) =>
  logError("autorole_handler_failed", { message: error.message });

const overwatchStatuses = [
  "Escorting the payload",
  "Contesting the point",
  "Cheers, love! The cavalry's here!",
  "It's high noon.",
  "Ryūjin no ken wo kurae!",
  "Justice rains from above!",
  "D.Va: 1, Bad guys: 0.",
  "Heroes never die!",
  "Nerf this!",
  "The world could always use more heroes",
  "Would you like to see my muscles?",
  "Propaganda is useless.",
  "Boop!",
  "egg",
] satisfies [string, ...string[]];

export function runAutorole(configuration: Configuration) {
  return runBot({
    token: configuration.token,
    client: { intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] },
    modules: [
      (client) =>
        makeAutorole(client, {
          path:
            process.env.AUTOROLE_STATE_PATH ||
            (process.env.STATE_DIRECTORY
              ? `${process.env.STATE_DIRECTORY}/assignments.sqlite`
              : "./data/assignments.sqlite"),
          guildId: configuration.guildId,
          report: (error, guildId, memberId) =>
            logError("autorole_assignment_error", {
              guildId,
              memberId,
              code: error instanceof DiscordRequestError ? error.code : undefined,
              message: asError(error).message,
            }),
        }),
    ],
    presence: { name: "Overwatch", statuses: overwatchStatuses, interval: MINUTE_MS },
    ready: (client) =>
      logInfo("autorole_connected", { user: client.user.tag }).pipe(Effect.andThen(notifyReady())),
    readyFailed: (error) =>
      logError("autorole_ready_notification_failed", { message: error.message }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    reportHandler,
    reportDiscord: (error) => logError("autorole_error", { message: error.message }),
  });
}
