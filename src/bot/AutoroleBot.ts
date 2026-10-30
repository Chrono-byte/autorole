import { Events, GatewayIntentBits } from "discord.js";
import { Deferred, Effect } from "effect";
import { handlers, makeClient } from "../../packages/discord/client";
import { rotatePresence } from "../../packages/discord/presence";
import { asError } from "../effectful";
import { DiscordRequestError, discordRequest } from "../errors";
import { type Configuration } from "../config/Configuration";
import { IntegrationSettings } from "../config/IntegrationSettings";
import { logError, logInfo } from "../logger";
import { AutoroleCommands } from "./AutoroleCommands";
import { OutstandingAssignments } from "./OutstandingAssignments";
import { notifyReady } from "./notifyReady";
import { RoleService } from "./RoleService";

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

export class AutoroleBot {
  constructor(private readonly configuration: Configuration) {}

  run() {
    const configuration = this.configuration;
    return Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const shutdown = yield* Deferred.make<void>();
      const client = yield* makeClient(
        { intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] },
        (discordClient) => discordRequest(() => discordClient.destroy()).pipe(Effect.ignore),
      );
      const roles = new RoleService(new IntegrationSettings(configuration.guildId));
      const assignments = yield* OutstandingAssignments.make(
        process.env.AUTOROLE_STATE_PATH ||
          (process.env.STATE_DIRECTORY
            ? `${process.env.STATE_DIRECTORY}/assignments.sqlite`
            : "./data/assignments.sqlite"),
        client,
        roles,
        (error, guildId, memberId) =>
          logError("autorole_assignment_error", {
            guildId,
            memberId,
            code: error instanceof DiscordRequestError ? error.code : undefined,
            message: asError(error).message,
          }),
        configuration.guildId,
      );
      const commands = new AutoroleCommands(roles);
      const on = handlers(client, reportHandler);
      yield* on(
        Events.ClientReady,
        (readyClient) =>
          Effect.gen(function* () {
            yield* Effect.forkIn(scope, { startImmediately: true })(assignments.start());
            yield* Effect.forkIn(scope, { startImmediately: true })(
              rotatePresence(readyClient, "Overwatch", overwatchStatuses, MINUTE_MS),
            );
            yield* logInfo("autorole_connected", { user: readyClient.user.tag });
            yield* notifyReady().pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* logError("autorole_ready_notification_failed", { message: error.message });
                  yield* Effect.sync(() => {
                    process.exitCode = 1;
                  });
                  yield* Deferred.succeed(shutdown, undefined);
                }),
              ),
            );
          }),
        true,
      );
      yield* on(Events.GuildMemberAdd, (member) => assignments.observeJoin(member));
      yield* on(Events.GuildMemberUpdate, (before, member) =>
        before.pending && !member.pending ? assignments.observe(member) : Effect.void,
      );
      yield* on(Events.GuildMemberAvailable, (member) => assignments.observe(member));
      yield* on(Events.InteractionCreate, (interaction) =>
        interaction.isChatInputCommand() ? commands.execute(interaction) : Effect.void,
      );
      yield* on(Events.Error, (error) => logError("autorole_error", { message: error.message }));
      yield* discordRequest(() => client.login(configuration.token));
      yield* Deferred.await(shutdown);
    });
  }
}
