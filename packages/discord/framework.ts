import {
  Events,
  type ChatInputCommandInteraction,
  type Client,
  type ClientEvents,
} from "discord.js";
import { Deferred, Effect } from "effect";
import { listen, runClient } from "./client";
import { rotatePresence } from "./presence";

export type CommandDefinition = { name: string; toJSON: () => { name: string } };
export type Command = {
  definition: CommandDefinition;
  run: (interaction: ChatInputCommandInteraction) => Effect.Effect<void, Error>;
};

export type CommandSpec<Context> = {
  definition: CommandDefinition;
  run: (context: Context, interaction: ChatInputCommandInteraction) => Effect.Effect<void, Error>;
};

/** Keep command metadata available before runtime dependencies are constructed. */
export class CommandCatalog<Context> {
  constructor(private readonly commands: readonly CommandSpec<Context>[]) {
    const names = new Set<string>();
    for (const command of commands) {
      const name = command.definition.name;
      if (names.has(name)) throw new Error(`Duplicate command: ${name}`);
      names.add(name);
    }
  }

  get definitions() {
    return this.commands.map(({ definition }) => definition);
  }

  bind(context: Context) {
    return new CommandRegistry(
      this.commands.map(({ definition, run }) => ({
        definition,
        run: (interaction) => run(context, interaction),
      })),
    );
  }
}

/** A command's definition is shared by dispatch and Discord registration. */
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  constructor(commands: readonly Command[]) {
    for (const command of commands) {
      const name = command.definition.name;
      if (this.commands.has(name)) throw new Error(`Duplicate command: ${name}`);
      this.commands.set(name, command);
    }
  }

  get definitions() {
    return Array.from(this.commands.values(), ({ definition }) => definition);
  }

  dispatch(interaction: ChatInputCommandInteraction) {
    const command = this.commands.get(interaction.commandName);
    return command ? command.run(interaction) : Effect.void;
  }
}

type Report = (error: Error) => Effect.Effect<void>;
export type EventHandler = (
  client: Client,
  report: Report,
) => Effect.Effect<void, never, import("effect").Scope.Scope>;

/** Typed event definitions can be composed into a framework installation. */
export function event<K extends keyof ClientEvents>(
  name: K,
  run: (...args: ClientEvents[K]) => Effect.Effect<void, Error>,
  options?: { once?: boolean },
): EventHandler {
  return (client, report) => listen(client, name, run, report, options?.once);
}

export const install = Effect.fn("Discord.install")(function* (
  client: Client,
  commands: CommandRegistry,
  events: readonly EventHandler[],
  report: Report,
) {
  yield* listen(
    client,
    Events.InteractionCreate,
    (interaction) =>
      interaction.isChatInputCommand() ? commands.dispatch(interaction) : Effect.void,
    report,
  );
  for (const handler of events) yield* handler(client, report);
});

export type BotModule = {
  commands: CommandRegistry;
  events: readonly EventHandler[];
};

/** Own the Discord lifecycle and install one bot's scoped behavior. */
export const runBot = Effect.fn("Discord.runBot")(function* (options: {
  token: string;
  client: import("discord.js").ClientOptions;
  setup: (client: Client) => Effect.Effect<BotModule, Error, import("effect").Scope.Scope>;
  reportHandler: Report;
  reportDiscord: Report;
  ready: (client: Client<true>) => Effect.Effect<void, Error>;
  readyFailed: Report;
  presence?: { name: string; statuses: readonly [string, ...string[]]; interval: number };
}) {
  const shutdown = yield* Deferred.make<void>();
  yield* runClient(
    options.client,
    options.token,
    (client) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const module = yield* options.setup(client);
        yield* install(
          client,
          module.commands,
          [
            ...module.events,
            event(
              Events.ClientReady,
              (readyClient) =>
                Effect.gen(function* () {
                  if (options.presence) {
                    const presence = options.presence;
                    yield* Effect.forkIn(scope, { startImmediately: true })(
                      rotatePresence(
                        readyClient,
                        presence.name,
                        presence.statuses,
                        presence.interval,
                      ),
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
      }),
    Deferred.await(shutdown),
  );
});
