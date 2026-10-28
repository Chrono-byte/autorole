import {
  ActivityType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type GuildMember,
  type Interaction,
  type PartialGuildMember,
} from "discord.js";
import { Deferred, Effect, Result, Schedule } from "effect";
import { asError, tryPromise, trySync } from "../effectful";
import { type Configuration } from "../config/Configuration";
import { IntegrationSettings } from "../config/IntegrationSettings";
import { logError, logInfo } from "../logger";
import { AutoroleCommands } from "./AutoroleCommands";
import { OutstandingAssignments } from "./OutstandingAssignments";
import { notifyReady } from "./notifyReady";
import { RoleService } from "./RoleService";

const MINUTE_MS = 60_000;

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
      const client = yield* Effect.acquireRelease(
        trySync(
          () =>
            new Client({
              intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
            }),
        ),
        (discordClient) => tryPromise(() => discordClient.destroy()).pipe(Effect.ignore),
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
            code: error instanceof DiscordAPIError ? error.code : undefined,
            message: asError(error).message,
          }),
        configuration.guildId,
      );
      const commands = new AutoroleCommands(roles);
      const fork = (effect: Effect.Effect<void, Error>) => {
        const handled = Effect.matchEffect(effect, {
          onFailure: (error) => logError("autorole_handler_failed", { message: error.message }),
          onSuccess: () => Effect.void,
        });
        Effect.runSync(Effect.forkIn(scope, { startImmediately: true })(handled));
      };
      const onReady = (readyClient: Client<true>) => {
        fork(
          Effect.gen(function* () {
            yield* Effect.forkIn(scope, { startImmediately: true })(assignments.start());
            let statusIndex = 0;
            const updatePresence = Effect.sync(() => {
              readyClient.user.setPresence({
                activities: [
                  {
                    name: "Overwatch",
                    type: ActivityType.Custom,
                    state: overwatchStatuses[statusIndex] ?? overwatchStatuses[0],
                  },
                ],
                status: "online",
              });
              statusIndex = (statusIndex + 1) % overwatchStatuses.length;
            });
            yield* Effect.forkIn(scope, { startImmediately: true })(
              updatePresence.pipe(Effect.repeat(Schedule.spaced(MINUTE_MS)), Effect.asVoid),
            );
            yield* logInfo("autorole_connected", { user: readyClient.user.tag });
            const notification = yield* Effect.result(notifyReady());
            if (Result.isFailure(notification)) {
              yield* logError("autorole_ready_notification_failed", {
                message: notification.failure.message,
              });
              yield* Effect.sync(() => {
                process.exitCode = 1;
              });
              yield* Deferred.succeed(shutdown, undefined);
            }
          }),
        );
      };
      const onMemberAdd = (member: GuildMember) => fork(assignments.observeJoin(member));
      const onMemberUpdate = (before: GuildMember | PartialGuildMember, member: GuildMember) => {
        if (before.pending && !member.pending) fork(assignments.observe(member));
      };
      const onMemberAvailable = (member: GuildMember | PartialGuildMember) =>
        fork(assignments.observe(member));
      const onInteraction = (interaction: Interaction) => {
        if (interaction.isChatInputCommand()) fork(commands.execute(interaction));
      };
      const onClientError = (error: Error) =>
        fork(logError("autorole_error", { message: error.message }));

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          client.once(Events.ClientReady, onReady);
          client.on(Events.GuildMemberAdd, onMemberAdd);
          client.on(Events.GuildMemberUpdate, onMemberUpdate);
          client.on(Events.GuildMemberAvailable, onMemberAvailable);
          client.on(Events.InteractionCreate, onInteraction);
          client.on(Events.Error, onClientError);
          return () => {
            client.off(Events.ClientReady, onReady);
            client.off(Events.GuildMemberAdd, onMemberAdd);
            client.off(Events.GuildMemberUpdate, onMemberUpdate);
            client.off(Events.GuildMemberAvailable, onMemberAvailable);
            client.off(Events.InteractionCreate, onInteraction);
            client.off(Events.Error, onClientError);
          };
        }),
        (removeListeners) => Effect.sync(removeListeners),
      );
      yield* tryPromise(() => client.login(configuration.token));
      yield* Deferred.await(shutdown);
    });
  }
}
