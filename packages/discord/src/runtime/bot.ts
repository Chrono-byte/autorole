import { Events, type Client } from "discord.js";
import { Deferred, Effect } from "effect";
import { CommandRegistry } from "../commands/registry";
import { runClient } from "./client";
import { event, install, type EventHandler, type Report } from "./events";
import { presenceTask } from "./presence";
import { runBackgroundTask, type BackgroundTask } from "./background";
import { BackgroundHealth, makeBackgroundHealth } from "./health";

export type BotModule = {
  commands: CommandRegistry;
  events: readonly EventHandler[];
  background?: readonly BackgroundTask[];
};

export type BotModuleFactory = (
  client: Client,
) => Effect.Effect<BotModule, Error, import("effect").Scope.Scope | BackgroundHealth>;

/** Combine modules before installing listeners, rejecting conflicting commands. */
export function composeModules(modules: readonly BotModule[]): BotModule {
  const background = modules.flatMap((module) => module.background ?? []);
  const names = new Set<string>();
  for (const task of background) {
    if (names.has(task.name)) throw new Error(`Duplicate background task: ${task.name}`);
    names.add(task.name);
  }
  return {
    commands: CommandRegistry.combine(modules.map((module) => module.commands)),
    events: modules.flatMap((module) => module.events),
    background,
  };
}

/** Own the Discord lifecycle and install scoped modules in declaration order. */
export const runBot = Effect.fn("Discord.runBot")(function* (options: {
  token: string;
  client: import("discord.js").ClientOptions;
  modules: readonly BotModuleFactory[];
  reportHandler: Report;
  reportDiscord: Report;
  ready: (client: Client<true>) => Effect.Effect<void, Error>;
  readyFailed: Report;
  presence?: { name: string; statuses: readonly [string, ...string[]]; interval: number };
}) {
  const shutdown = yield* Deferred.make<void>();
  const health = yield* makeBackgroundHealth();
  yield* runClient(
    options.client,
    options.token,
    (client) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const modules: BotModule[] = [];
        for (const make of options.modules) modules.push(yield* make(client));
        if (options.presence)
          modules.push({
            commands: new CommandRegistry([]),
            events: [],
            background: [presenceTask(options.presence)],
          });
        const module = yield* Effect.try({
          try: () => composeModules(modules),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
        const tasks = yield* health.register(module.background ?? []);
        yield* Effect.addFinalizer(() => health.stop);
        yield* install(
          client,
          module.commands,
          [
            ...module.events,
            event(
              Events.ClientReady,
              (readyClient) =>
                Effect.gen(function* () {
                  for (const entry of tasks) {
                    yield* Effect.forkIn(scope, { startImmediately: true })(
                      runBackgroundTask({
                        ...entry,
                        client: readyClient,
                        report: options.reportHandler,
                      }),
                    );
                  }
                  yield* options
                    .ready(readyClient)
                    .pipe(
                      Effect.catch((error) =>
                        options
                          .readyFailed(error)
                          .pipe(
                            Effect.andThen(Deferred.succeed(shutdown, undefined)),
                            Effect.asVoid,
                          ),
                      ),
                    );
                }),
              { once: true },
            ),
            event(Events.Error, options.reportDiscord),
          ],
          options.reportHandler,
        );
      }).pipe(Effect.provideService(BackgroundHealth, health.service)),
    Deferred.await(shutdown),
  );
});
