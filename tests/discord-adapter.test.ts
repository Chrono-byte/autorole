import { expect, spyOn, test } from "bun:test";
import { Events, type Client } from "discord.js";
import { Deferred, Effect } from "effect";
import { listen, makeClient } from "../packages/discord/client";

test("listeners run handlers, report failures, and are removed with their scope", async () => {
  const handled: string[] = [];
  const errors: string[] = [];
  let client: Client | undefined;
  let closed = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        client = yield* makeClient({ intents: [] }, () =>
          Effect.sync(() => {
            closed = true;
          }),
        );
        yield* listen(
          client,
          Events.Error,
          (error) =>
            Effect.sync(() => {
              handled.push(error.message);
            }).pipe(Effect.andThen(Effect.fail(new Error("handler failed")))),
          (error) =>
            Effect.sync(() => {
              errors.push(error.message);
            }),
          true,
        );
        client.emit(Events.Error, new Error("first"));
        expect(handled).toEqual(["first"]);
        expect(errors).toEqual(["handler failed"]);
        expect(client.listenerCount(Events.Error)).toBe(0);
        yield* listen(
          client,
          Events.Error,
          () => Effect.void,
          () => Effect.void,
        );
        expect(client.listenerCount(Events.Error)).toBe(1);
      }),
    ),
  );
  expect(client?.listenerCount(Events.Error)).toBe(0);
  expect(closed).toBe(true);
});

test("scope closure interrupts running event handlers", async () => {
  let interrupted = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeClient({ intents: [] }, () => Effect.void);
        const started = yield* Deferred.make<void>();
        yield* listen(
          client,
          Events.Error,
          () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            ),
          () => Effect.void,
        );
        client.emit(Events.Error, new Error("start"));
        yield* Deferred.await(started);
      }),
    ),
  );
  expect(interrupted).toBe(true);
});

test("command upserts use the selected scope and preserve unrelated commands", async () => {
  const { REST, Routes } = await import("discord.js");
  const { upsertCommands } = await import("../packages/discord/commands");
  const rest = new REST({ version: "10" });
  const routes: string[] = [];
  const post = spyOn(rest, "post").mockImplementation(async (route) => {
    routes.push(route);
    return {};
  });
  const definitions = [{ toJSON: () => ({ name: "one" }) }, { toJSON: () => ({ name: "two" }) }];
  try {
    await Effect.runPromise(upsertCommands(rest, "app", "guild", definitions));
    await Effect.runPromise(upsertCommands(rest, "app", undefined, definitions));
    expect(routes).toEqual([
      Routes.applicationGuildCommands("app", "guild"),
      Routes.applicationGuildCommands("app", "guild"),
      Routes.applicationCommands("app"),
      Routes.applicationCommands("app"),
    ]);
  } finally {
    post.mockRestore();
  }
});

test("presence rotates immediately and stops when interrupted", async () => {
  const { rotatePresence } = await import("../packages/discord/presence");
  const { TestClock } = await import("effect/testing");
  const { Fiber } = await import("effect");
  const states: string[] = [];
  const client = {
    user: {
      setPresence: (presence: { activities: { state: string }[] }) => {
        const state = presence.activities[0]?.state;
        if (state) states.push(state);
      },
    },
  } as unknown as Client<true>;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        rotatePresence(client, "Game", ["first", "second"], 60_000),
        { startImmediately: true },
      );
      expect(states).toEqual(["first"]);
      yield* TestClock.adjust(60_000);
      expect(states).toEqual(["first", "second"]);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(60_000);
      expect(states).toEqual(["first", "second"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test("command registry dispatches, rejects duplicate names, and ignores unknown commands", async () => {
  const { CommandRegistry } = await import("../packages/discord/framework");
  const calls: string[] = [];
  const command = {
    definition: { name: "ping", toJSON: () => ({ name: "ping" }) },
    run: () =>
      Effect.sync(() => {
        calls.push("ping");
      }),
  };
  const registry = new CommandRegistry([command]);
  expect(registry.definitions.map((definition) => definition.toJSON())).toEqual([{ name: "ping" }]);
  expect(() => new CommandRegistry([command, command])).toThrow("Duplicate command: ping");
  await Effect.runPromise(
    registry.dispatch({ commandName: "ping" } as import("discord.js").ChatInputCommandInteraction),
  );
  await Effect.runPromise(
    registry.dispatch({
      commandName: "unknown",
    } as import("discord.js").ChatInputCommandInteraction),
  );
  expect(calls).toEqual(["ping"]);
});

test("framework routes commands and typed events, reports failures, and removes listeners", async () => {
  const { Client } = await import("discord.js");
  const { CommandRegistry, event, install } = await import("../packages/discord/framework");
  const client = new Client({ intents: [] });
  const handled: string[] = [];
  const errors: string[] = [];
  const registry = new CommandRegistry([
    {
      definition: { name: "ping", toJSON: () => ({ name: "ping" }) },
      run: () => Effect.fail(new Error("command failed")),
    },
  ]);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* install(
          client,
          registry,
          [
            event(Events.Error, (error) =>
              Effect.sync(() => {
                handled.push(error.message);
              }),
            ),
          ],
          (error) =>
            Effect.sync(() => {
              errors.push(error.message);
            }),
        );
        const interaction = {
          commandName: "ping",
          isChatInputCommand: () => true,
          reply: async () => undefined,
        } as unknown as import("discord.js").Interaction;
        client.emit(Events.InteractionCreate, interaction);
        client.emit(Events.Error, new Error("event"));
        expect(errors).toEqual(["command failed"]);
        expect(handled).toEqual(["event"]);
      }),
    ),
  );
  expect(client.listenerCount(Events.InteractionCreate)).toBe(0);
  expect(client.listenerCount(Events.Error)).toBe(0);
  await client.destroy();
});

test("client runner installs before login and releases the client on scope exit", async () => {
  const { Client } = await import("discord.js");
  const { runClient } = await import("../packages/discord/client");
  const calls: string[] = [];
  const login = spyOn(Client.prototype, "login").mockImplementation(async () => {
    calls.push("login");
    return "token";
  });
  const destroy = spyOn(Client.prototype, "destroy").mockImplementation(async () => {
    calls.push("destroy");
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        runClient(
          { intents: [] },
          "token",
          () =>
            Effect.sync(() => {
              calls.push("setup");
            }),
          Effect.sync(() => {
            calls.push("stop");
          }),
        ),
      ),
    );
    expect(calls).toEqual(["setup", "login", "stop", "destroy"]);
  } finally {
    login.mockRestore();
    destroy.mockRestore();
  }
});

test("command catalog shares registration metadata and binds independent dependencies", async () => {
  const { CommandCatalog } = await import("../packages/discord");
  const seen: string[] = [];
  const catalog = new CommandCatalog<string>([
    {
      definition: { name: "ping", toJSON: () => ({ name: "ping" }) },
      run: (prefix, interaction) =>
        Effect.sync(() => {
          seen.push(`${prefix}:${interaction.commandName}`);
        }),
    },
  ]);
  const interaction = { commandName: "ping" } as import("discord.js").ChatInputCommandInteraction;
  expect(catalog.definitions.map((definition) => definition.toJSON().name)).toEqual(["ping"]);
  await Effect.runPromise(catalog.bind("first").dispatch(interaction));
  await Effect.runPromise(catalog.bind("second").dispatch(interaction));
  expect(seen).toEqual(["first:ping", "second:ping"]);
  expect(() => new CommandCatalog([catalogSpec(), catalogSpec()])).toThrow(
    "Duplicate command: ping",
  );
});

function catalogSpec() {
  return { definition: { name: "ping", toJSON: () => ({ name: "ping" }) }, run: () => Effect.void };
}

test("client runner closes the client when setup or login fails", async () => {
  const { Client } = await import("discord.js");
  const { runClient } = await import("../packages/discord/client");
  let closed = 0;
  const login = spyOn(Client.prototype, "login").mockImplementation(async () => {
    throw new Error("login failed");
  });
  const destroy = spyOn(Client.prototype, "destroy").mockImplementation(async () => {
    closed++;
  });
  try {
    await expect(
      Effect.runPromise(
        Effect.scoped(
          runClient({ intents: [] }, "token", () => Effect.fail(new Error("setup failed"))),
        ),
      ),
    ).rejects.toThrow("setup failed");
    expect(login).not.toHaveBeenCalled();
    await expect(
      Effect.runPromise(Effect.scoped(runClient({ intents: [] }, "token", () => Effect.void))),
    ).rejects.toThrow("login failed");
    expect(closed).toBe(2);
  } finally {
    login.mockRestore();
    destroy.mockRestore();
  }
});

test("bot runner starts module before readiness and shuts down on readiness failure", async () => {
  const { Client } = await import("discord.js");
  const { CommandRegistry, event, runBot } = await import("../packages/discord");
  const calls: string[] = [];
  let runningClient: import("discord.js").Client | undefined;
  const login = spyOn(Client.prototype, "login").mockImplementation(async function (
    this: import("discord.js").Client,
  ) {
    calls.push("login");
    this.emit(Events.ClientReady, this as import("discord.js").Client<true>);
    return "token";
  });
  const destroy = spyOn(Client.prototype, "destroy").mockImplementation(async () => {
    calls.push("destroy");
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        runBot({
          token: "token",
          client: { intents: [] },
          modules: [
            (client) =>
              Effect.sync(() => {
                runningClient = client;
                calls.push("setup");
                return {
                  commands: new CommandRegistry([]),
                  events: [
                    event(
                      Events.ClientReady,
                      () =>
                        Effect.sync(() => {
                          calls.push("module ready");
                        }),
                      { once: true },
                    ),
                  ],
                };
              }),
          ],
          ready: () =>
            Effect.sync(() => {
              calls.push("ready");
            }).pipe(Effect.andThen(Effect.fail(new Error("notification failed")))),
          readyFailed: (error) =>
            Effect.sync(() => {
              calls.push(error.message);
            }),
          reportHandler: () => Effect.void,
          reportDiscord: () => Effect.void,
        }),
      ),
    );
    expect(calls).toEqual([
      "setup",
      "login",
      "module ready",
      "ready",
      "notification failed",
      "destroy",
    ]);
    expect(runningClient?.listenerCount(Events.ClientReady)).toBe(0);
    expect(runningClient?.listenerCount(Events.InteractionCreate)).toBe(0);
  } finally {
    login.mockRestore();
    destroy.mockRestore();
  }
});

test("modules combine commands and events while rejecting duplicate command names", async () => {
  const { Client } = await import("discord.js");
  const { CommandRegistry, composeModules, event, install } = await import("../packages/discord");
  const client = new Client({ intents: [] });
  const calls: string[] = [];
  const first = {
    commands: new CommandRegistry([
      {
        definition: { name: "first", toJSON: () => ({ name: "first" }) },
        run: () =>
          Effect.sync(() => {
            calls.push("first command");
          }),
      },
    ]),
    events: [
      event(Events.Error, () =>
        Effect.sync(() => {
          calls.push("first event");
        }),
      ),
    ],
  };
  const second = {
    commands: new CommandRegistry([
      {
        definition: { name: "second", toJSON: () => ({ name: "second" }) },
        run: () =>
          Effect.sync(() => {
            calls.push("second command");
          }),
      },
    ]),
    events: [
      event(Events.Error, () =>
        Effect.sync(() => {
          calls.push("second event");
        }),
      ),
    ],
  };
  const combined = composeModules([first, second]);
  expect(combined.commands.definitions.map((definition) => definition.name)).toEqual([
    "first",
    "second",
  ]);
  expect(() => composeModules([first, first])).toThrow("Duplicate command: first");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* install(client, combined.commands, combined.events, () => Effect.void);
        for (const commandName of ["first", "second"]) {
          client.emit(Events.InteractionCreate, {
            commandName,
            isChatInputCommand: () => true,
          } as import("discord.js").Interaction);
        }
        client.emit(Events.Error, new Error("test"));
        expect(calls).toEqual(["first command", "second command", "first event", "second event"]);
      }),
    ),
  );
  expect(client.listenerCount(Events.Error)).toBe(0);
  expect(client.listenerCount(Events.InteractionCreate)).toBe(0);
  await client.destroy();
});

test("conflicting modules fail before login and release acquired resources", async () => {
  const { Client } = await import("discord.js");
  const { CommandRegistry, runBot } = await import("../packages/discord");
  const calls: string[] = [];
  const login = spyOn(Client.prototype, "login").mockImplementation(async () => {
    calls.push("login");
    return "token";
  });
  const destroy = spyOn(Client.prototype, "destroy").mockImplementation(async () => {
    calls.push("destroy");
  });
  const module = () =>
    Effect.acquireRelease(
      Effect.sync(() => {
        calls.push("acquire");
        return {
          commands: new CommandRegistry([
            {
              definition: { name: "same", toJSON: () => ({ name: "same" }) },
              run: () => Effect.void,
            },
          ]),
          events: [],
        };
      }),
      () =>
        Effect.sync(() => {
          calls.push("release");
        }),
    );
  try {
    await expect(
      Effect.runPromise(
        Effect.scoped(
          runBot({
            token: "token",
            client: { intents: [] },
            modules: [module, module],
            ready: () => Effect.void,
            readyFailed: () => Effect.void,
            reportHandler: () => Effect.void,
            reportDiscord: () => Effect.void,
          }),
        ),
      ),
    ).rejects.toThrow("Duplicate command: same");
    expect(calls).toEqual(["acquire", "acquire", "release", "release", "destroy"]);
  } finally {
    login.mockRestore();
    destroy.mockRestore();
  }
});
