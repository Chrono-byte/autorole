import { expect, spyOn, test } from "bun:test";
import { Client, Events } from "discord.js";
import { DateTime, Deferred, Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import {
  type BackgroundTask,
  CommandRegistry,
  composeModules,
  runBot,
} from "@autorole/discord-framework";

async function withTasks(
  tasks: readonly BackgroundTask[],
  inspect: (stop: Effect.Effect<void>) => Effect.Effect<void>,
  report: (error: Error) => Effect.Effect<void> = () => Effect.void,
) {
  const ready = Deferred.makeUnsafe<void>();
  let closed = false;
  const login = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
    this.emit(Events.ClientReady, this as Client<true>);
    this.emit(Events.ClientReady, this as Client<true>);
    return "fixture";
  });
  const destroy = spyOn(Client.prototype, "destroy").mockImplementation(async () => {
    closed = true;
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bot = yield* Effect.forkChild(
            Effect.scoped(
              runBot({
                token: "fixture",
                client: { intents: [] },
                modules: [
                  () =>
                    Effect.succeed({
                      commands: new CommandRegistry([]),
                      events: [],
                      background: tasks,
                    }),
                ],
                ready: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
                readyFailed: () => Effect.void,
                reportHandler: report,
                reportDiscord: report,
              }),
            ),
          );
          yield* Deferred.await(ready);
          yield* inspect(Fiber.interrupt(bot).pipe(Effect.asVoid));
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
    expect(closed).toBe(true);
  } finally {
    login.mockRestore();
    destroy.mockRestore();
  }
}

test("background passes start once at readiness, wait after completion, and stop with the bot", async () => {
  const starts: number[] = [];
  const finished: number[] = [];
  const errors: string[] = [];
  let healthy = 0;
  let interrupted = false;
  await withTasks(
    [
      {
        name: "slow",
        interval: "1 minute",
        onFailure: "continue",
        run: () =>
          Effect.gen(function* () {
            starts.push(DateTime.toEpochMillis(yield* DateTime.now));
            yield* Effect.sleep("30 seconds");
            finished.push(DateTime.toEpochMillis(yield* DateTime.now));
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      },
      {
        name: "healthy",
        interval: "10 seconds",
        onFailure: "continue",
        run: () =>
          Effect.sync(() => {
            healthy++;
          }),
      },
    ],
    (stop) =>
      Effect.gen(function* () {
        expect(starts).toEqual([0]);
        expect(healthy).toBe(1);
        yield* TestClock.adjust("1 minute");
        expect(starts).toEqual([0]);
        expect(finished).toEqual([30_000]);
        expect(healthy).toBe(7);
        yield* TestClock.adjust("30 seconds");
        expect(starts).toEqual([0, 90_000]);
        yield* stop;
        expect(interrupted).toBe(true);
        const count = healthy;
        yield* TestClock.adjust("10 minutes");
        expect(starts).toEqual([0, 90_000]);
        expect(healthy).toBe(count);
        expect(errors).toEqual([]);
      }),
    (error) =>
      Effect.sync(() => {
        errors.push(error.message);
      }),
  );
});

test("background failure policy continues or stops one task and reports its name and status", async () => {
  const reports: unknown[] = [];
  const logger = Logger.make((options) => {
    const entry = Logger.formatStructured.log(options);
    reports.push({ message: entry.message, ...entry.annotations });
  });
  let continuing = 0;
  let stopping = 0;
  let defective = 0;
  let healthy = 0;
  const tasks: BackgroundTask[] = [
    {
      name: "continuing",
      interval: "1 minute",
      onFailure: "continue",
      run: () =>
        Effect.suspend(() => {
          continuing++;
          return continuing === 1 ? Effect.fail(new Error("temporary")) : Effect.void;
        }),
    },
    {
      name: "stopping",
      interval: "1 minute",
      onFailure: "stop",
      run: () =>
        Effect.suspend(() => {
          stopping++;
          return Effect.fail(new Error("fatal"));
        }),
    },
    {
      name: "defective",
      interval: "1 minute",
      onFailure: "continue",
      run: () =>
        Effect.sync(() => {
          defective++;
          throw new Error("defect");
        }),
    },
    {
      name: "healthy",
      interval: "1 minute",
      onFailure: "continue",
      run: () =>
        Effect.sync(() => {
          healthy++;
        }),
    },
  ];
  await withTasks(
    tasks,
    () =>
      Effect.gen(function* () {
        expect([continuing, stopping, defective, healthy]).toEqual([1, 1, 1, 1]);
        yield* TestClock.adjust("1 minute");
        expect([continuing, stopping, defective, healthy]).toEqual([2, 1, 1, 2]);
        expect(reports).toEqual([
          {
            message: "temporary",
            backgroundTask: "continuing",
            failurePolicy: "continue",
            backgroundTaskStatus: "retrying",
          },
          {
            message: "fatal",
            backgroundTask: "stopping",
            failurePolicy: "stop",
            backgroundTaskStatus: "stopped",
          },
          {
            message: "defect",
            backgroundTask: "defective",
            failurePolicy: "continue",
            backgroundTaskStatus: "stopped",
          },
        ]);
      }),
    (error) => Effect.logError(error.message).pipe(Effect.provide(Logger.layer([logger]))),
  );
});

test("duplicate background names are rejected across modules", () => {
  const module = {
    commands: new CommandRegistry([]),
    events: [],
    background: [
      {
        name: "duplicate",
        interval: "1 minute",
        onFailure: "continue",
        run: () => Effect.void,
      } satisfies BackgroundTask,
    ],
  };
  expect(() => composeModules([module, module])).toThrow("Duplicate background task: duplicate");
});
