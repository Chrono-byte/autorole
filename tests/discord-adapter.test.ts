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
