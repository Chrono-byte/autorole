import { Events, GatewayIntentBits } from "discord.js";
import { Deferred, Effect } from "effect";
import {
  discordRequest,
  event,
  install,
  makeClient,
  rotatePresence,
} from "@autorole/discord-framework";
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

export const runAutorole = Effect.fn("Autorole.run")(function* (configuration: Configuration) {
  const scope = yield* Effect.scope;
  const shutdown = yield* Deferred.make<void>();
  const client = yield* makeClient(
    { intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] },
    (discordClient) => discordRequest(() => discordClient.destroy()).pipe(Effect.ignore),
  );
  const autorole = yield* makeAutorole(client, {
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
  });
  yield* install(
    client,
    autorole.commands,
    [
      ...autorole.events,
      event(
        Events.ClientReady,
        (readyClient) =>
          Effect.gen(function* () {
            yield* Effect.forkIn(scope, { startImmediately: true })(autorole.start);
            yield* Effect.forkIn(scope, { startImmediately: true })(
              rotatePresence(readyClient, "Overwatch", overwatchStatuses, MINUTE_MS),
            );
            yield* logInfo("autorole_connected", { user: readyClient.user.tag });
            yield* notifyReady().pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* logError("autorole_ready_notification_failed", {
                    message: error.message,
                  });
                  yield* Effect.sync(() => {
                    process.exitCode = 1;
                  });
                  yield* Deferred.succeed(shutdown, undefined);
                }),
              ),
            );
          }),
        { once: true },
      ),
      event(Events.Error, (error) => logError("autorole_error", { message: error.message })),
    ],
    reportHandler,
  );
  yield* discordRequest(() => client.login(configuration.token));
  yield* Deferred.await(shutdown);
});
