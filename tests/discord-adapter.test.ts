import { expect, test } from "bun:test";
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
