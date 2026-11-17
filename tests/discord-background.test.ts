import { expect, spyOn, test } from "bun:test";
import { Client, Events } from "discord.js";
import { DateTime, Deferred, Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import {
  type BackgroundTask,
  type BackgroundTaskHealth,
  BackgroundHealth,
  CommandRegistry,
  composeModules,
  runBot,
} from "@autorole/discord-framework";

async function withTasks(
  tasks: readonly BackgroundTask[],
  inspect: (stop: Effect.Effect<void>, health: BackgroundHealth["Service"]) => Effect.Effect<void>,
  report: (error: Error) => Effect.Effect<void> = () => Effect.void,
  options: {
    logs?: unknown[];
    presence?: Parameters<typeof runBot>[0]["presence"];
    onPresence?: () => void;
  } = {},
) {
  const ready = Deferred.makeUnsafe<void>();
  const healthReady = Deferred.makeUnsafe<BackgroundHealth["Service"]>();
  const logger = Logger.make((entry) => {
    const value = Logger.formatStructured.log(entry);
    options.logs?.push({ message: value.message, ...value.annotations });
  });
  let closed = false;
  const login = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
    Object.defineProperty(this, "user", {
      value: { setPresence: () => options.onPresence?.() },
      configurable: true,
    });
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
                    Effect.gen(function* () {
                      yield* Deferred.succeed(healthReady, yield* BackgroundHealth);
                      return {
                        commands: new CommandRegistry([]),
                        events: [],
                        background: tasks,
                      };
                    }),
                ],
                ready: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
                readyFailed: () => Effect.void,
                reportHandler: report,
                reportDiscord: report,
                presence: options.presence,
              }),
            ),
          );
          yield* Deferred.await(ready);
          yield* inspect(
            Fiber.interrupt(bot).pipe(Effect.asVoid),
            yield* Deferred.await(healthReady),
          );
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
    );
    expect(closed).toBe(true);
  } finally {
    login.mockRestore();
    destroy.mockRestore();
  }
}

for (const failure of ["typed", "defect", "factory"] as const) {
  test(`a continue task recovers after a ${failure} failure`, async () => {
    let attempts = 0;
    const errors: string[] = [];
    await withTasks(
      [
        {
          name: "recovering",
          interval: "1 minute",
          timeout: "5 minutes",
          onFailure: "continue",
          run: () => {
            attempts++;
            if (attempts > 1) return Effect.void;
            if (failure === "factory") throw new Error("temporary");
            return failure === "defect"
              ? Effect.die(new Error("temporary"))
              : Effect.fail(new Error("temporary"));
          },
        },
      ],
      () =>
        Effect.gen(function* () {
          expect(attempts).toBe(1);
          yield* TestClock.adjust("1 minute");
          expect(attempts).toBe(2);
          yield* TestClock.adjust("1 minute");
          expect(attempts).toBe(3);
          expect(errors).toEqual(["temporary"]);
        }),
      (error) =>
        Effect.sync(() => {
          errors.push(error.message);
        }),
    );
  });
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
        timeout: "5 minutes",
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
        timeout: "5 minutes",
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
      timeout: "5 minutes",
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
      timeout: "5 minutes",
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
      timeout: "5 minutes",
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
      timeout: "5 minutes",
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
        expect([continuing, stopping, defective, healthy]).toEqual([2, 1, 2, 2]);
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
            backgroundTaskStatus: "retrying",
          },
          {
            message: "defect",
            backgroundTask: "defective",
            failurePolicy: "continue",
            backgroundTaskStatus: "retrying",
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
        timeout: "5 minutes",
        onFailure: "continue",
        run: () => Effect.void,
      } satisfies BackgroundTask,
    ],
  };
  expect(() => composeModules([module, module])).toThrow("Duplicate background task: duplicate");
});

test("task health retains failure history, resets failures after recovery, and records shutdown", async () => {
  let attempts = 0;
  const logs: unknown[] = [];
  await withTasks(
    [
      {
        name: "recovering",
        interval: "1 minute",
        timeout: "5 minutes",
        onFailure: "continue",
        run: () =>
          Effect.suspend(() => {
            attempts++;
            return attempts === 3 ? Effect.void : Effect.fail(new Error(`failure ${attempts}`));
          }),
      },
    ],
    (stop, health) =>
      Effect.gen(function* () {
        expect(yield* health.snapshot).toEqual([
          {
            name: "recovering",
            status: "retrying",
            nextRunAt: 60_000,
            lastSuccessAt: null,
            lastFailure: { at: 0, message: "failure 1", kind: "failure" },
            consecutiveFailures: 1,
          },
        ]);
        yield* TestClock.adjust("1 minute");
        expect(yield* health.snapshot).toEqual([
          {
            name: "recovering",
            status: "retrying",
            nextRunAt: 120_000,
            lastSuccessAt: null,
            lastFailure: { at: 60_000, message: "failure 2", kind: "failure" },
            consecutiveFailures: 2,
          },
        ]);
        yield* TestClock.adjust("1 minute");
        expect(yield* health.snapshot).toEqual([
          {
            name: "recovering",
            status: "healthy",
            nextRunAt: 180_000,
            lastSuccessAt: 120_000,
            lastFailure: { at: 60_000, message: "failure 2", kind: "failure" },
            consecutiveFailures: 0,
          },
        ]);
        expect(logs).toEqual([
          {
            message: "background_task_recovered",
            backgroundTask: "recovering",
            failurePolicy: "continue",
            consecutiveFailures: 2,
          },
        ]);
        yield* TestClock.adjust("1 minute");
        expect((yield* health.snapshot)[0]?.consecutiveFailures).toBe(1);
        yield* stop;
        expect(yield* health.snapshot).toEqual([
          {
            name: "recovering",
            status: "stopped",
            reason: "shutdown",
            lastSuccessAt: 120_000,
            lastFailure: { at: 180_000, message: "failure 4", kind: "failure" },
            consecutiveFailures: 1,
          },
        ]);
        yield* TestClock.adjust("10 minutes");
        expect(attempts).toBe(4);
      }),
    () => Effect.void,
    { logs },
  );
});

test("failed passes release scoped resources before retry and active passes release them on shutdown", async () => {
  let active = 0;
  let released = 0;
  let attempts = 0;
  await withTasks(
    [
      {
        name: "resources",
        interval: "1 minute",
        timeout: "5 minutes",
        onFailure: "continue",
        run: () =>
          Effect.gen(function* () {
            attempts++;
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                active++;
              }),
              () =>
                Effect.sync(() => {
                  active--;
                  released++;
                }),
            );
            if (attempts === 1) return yield* Effect.die(new Error("temporary"));
            yield* Effect.never;
          }),
      },
    ],
    (stop, health) =>
      Effect.gen(function* () {
        expect([active, released]).toEqual([0, 1]);
        expect((yield* health.snapshot)[0]?.status).toBe("retrying");
        yield* TestClock.adjust("1 minute");
        expect([active, released]).toEqual([1, 1]);
        expect(yield* health.snapshot).toEqual([
          {
            name: "resources",
            status: "running",
            startedAt: 60_000,
            lastSuccessAt: null,
            lastFailure: { at: 0, message: "temporary", kind: "defect" },
            consecutiveFailures: 1,
          },
        ]);
        yield* stop;
        expect([active, released]).toEqual([0, 2]);
        expect((yield* health.snapshot)[0]?.status).toBe("stopped");
        yield* TestClock.adjust("10 minutes");
        expect(attempts).toBe(2);
      }),
  );
});

test("a stopped failure remains visible and does not retry", async () => {
  let attempts = 0;
  await withTasks(
    [
      {
        name: "terminal",
        interval: "1 minute",
        timeout: "5 minutes",
        onFailure: "stop",
        run: () =>
          Effect.suspend(() => {
            attempts++;
            return Effect.fail(new Error("halted"));
          }),
      },
    ],
    (stop, health) =>
      Effect.gen(function* () {
        const expected = [
          {
            name: "terminal",
            status: "stopped",
            reason: "failure",
            lastSuccessAt: null,
            lastFailure: { at: 0, message: "halted", kind: "failure" },
            consecutiveFailures: 1,
          },
        ] satisfies readonly BackgroundTaskHealth[];
        expect(yield* health.snapshot).toEqual(expected);
        yield* TestClock.adjust("10 minutes");
        expect(attempts).toBe(1);
        yield* stop;
        expect(yield* health.snapshot).toEqual(expected);
      }),
  );
});

test("presence is supervised and recovers after a failed update", async () => {
  let attempts = 0;
  await withTasks(
    [],
    (stop, health) =>
      Effect.gen(function* () {
        expect(yield* health.snapshot).toEqual([
          {
            name: "presence",
            status: "retrying",
            nextRunAt: 60_000,
            lastSuccessAt: null,
            lastFailure: { at: 0, message: "presence failed", kind: "defect" },
            consecutiveFailures: 1,
          },
        ]);
        yield* TestClock.adjust("1 minute");
        expect(attempts).toBe(2);
        expect((yield* health.snapshot)[0]).toMatchObject({
          status: "healthy",
          lastSuccessAt: 60_000,
          consecutiveFailures: 0,
        });
        yield* stop;
        yield* TestClock.adjust("10 minutes");
        expect(attempts).toBe(2);
      }),
    () => Effect.void,
    {
      presence: { name: "Game", statuses: ["playing"], interval: 60_000 },
      onPresence: () => {
        attempts++;
        if (attempts === 1) throw new Error("presence failed");
      },
    },
  );
});

test("a reporting failure cannot prevent task recovery", async () => {
  let attempts = 0;
  const logs: unknown[] = [];
  await withTasks(
    [
      {
        name: "reporting",
        interval: "1 minute",
        timeout: "5 minutes",
        onFailure: "continue",
        run: () =>
          Effect.suspend(() => {
            attempts++;
            return attempts === 1 ? Effect.fail(new Error("temporary")) : Effect.void;
          }),
      },
    ],
    (_stop, health) =>
      Effect.gen(function* () {
        expect((yield* health.snapshot)[0]?.status).toBe("retrying");
        yield* TestClock.adjust("1 minute");
        expect(attempts).toBe(2);
        expect((yield* health.snapshot)[0]?.status).toBe("healthy");
        expect(logs).toHaveLength(2);
        expect(logs[1]).toMatchObject({
          message: "background_task_recovered",
          backgroundTask: "reporting",
        });
      }),
    () => {
      throw new Error("report failed");
    },
    { logs },
  );
});

test("the recorded retry time includes time spent reporting the failure", async () => {
  let attempts = 0;
  await withTasks(
    [
      {
        name: "slow-report",
        interval: "1 minute",
        timeout: "5 minutes",
        onFailure: "continue",
        run: () =>
          Effect.suspend(() => {
            attempts++;
            return attempts === 1 ? Effect.fail(new Error("temporary")) : Effect.void;
          }),
      },
    ],
    (_stop, health) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("30 seconds");
        expect((yield* health.snapshot)[0]).toMatchObject({
          status: "retrying",
          nextRunAt: 90_000,
        });
        yield* TestClock.adjust("1 minute");
        expect(attempts).toBe(2);
        expect((yield* health.snapshot)[0]).toMatchObject({
          status: "healthy",
          lastSuccessAt: 90_000,
        });
      }),
    () => Effect.sleep("30 seconds"),
  );
});

test("task-specific deadlines release resources, record timeouts, and retry independently", async () => {
  let attempts = 0;
  let active = 0;
  let released = 0;
  const errors: string[] = [];
  await withTasks(
    [
      {
        name: "short",
        interval: "1 minute",
        timeout: "30 seconds",
        onFailure: "continue",
        run: () =>
          Effect.gen(function* () {
            attempts++;
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                active++;
              }),
              () =>
                Effect.sync(() => {
                  active--;
                  released++;
                }),
            );
            if (attempts === 1) yield* Effect.never;
          }),
      },
      {
        name: "long",
        interval: "1 minute",
        timeout: "90 seconds",
        onFailure: "continue",
        run: () => Effect.never,
      },
    ],
    (stop, health) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("29 seconds");
        expect([active, released, attempts]).toEqual([1, 0, 1]);
        expect(errors).toEqual([]);
        yield* TestClock.adjust("1 second");
        expect([active, released, attempts]).toEqual([0, 1, 1]);
        expect(yield* health.snapshot).toEqual([
          {
            name: "short",
            status: "retrying",
            nextRunAt: 90_000,
            lastSuccessAt: null,
            lastFailure: {
              at: 30_000,
              kind: "timeout",
              message: "short exceeded its 30s deadline.",
            },
            consecutiveFailures: 1,
          },
          {
            name: "long",
            status: "running",
            startedAt: 0,
            lastSuccessAt: null,
            lastFailure: null,
            consecutiveFailures: 0,
          },
        ]);
        yield* TestClock.adjust("1 minute");
        expect([active, released, attempts]).toEqual([0, 2, 2]);
        expect((yield* health.snapshot)[0]).toMatchObject({
          status: "healthy",
          lastSuccessAt: 90_000,
          consecutiveFailures: 0,
        });
        expect((yield* health.snapshot)[1]).toMatchObject({
          status: "retrying",
          lastFailure: { at: 90_000, kind: "timeout" },
        });
        expect(errors).toEqual([
          "short exceeded its 30s deadline.",
          "long exceeded its 1m 30s deadline.",
        ]);
        yield* stop;
        yield* TestClock.adjust("10 minutes");
        expect(attempts).toBe(2);
      }),
    (error) =>
      Effect.sync(() => {
        errors.push(error.message);
      }),
  );
});

test("a hung failure reporter is interrupted so the task can retry", async () => {
  let attempts = 0;
  let reporterInterrupted = false;
  const logs: unknown[] = [];
  await withTasks(
    [
      {
        name: "hung-report",
        interval: "1 minute",
        timeout: "2 minutes",
        onFailure: "continue",
        run: () =>
          Effect.suspend(() => {
            attempts++;
            return attempts === 1 ? Effect.fail(new Error("temporary")) : Effect.void;
          }),
      },
    ],
    (_stop, health) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("30 seconds");
        expect(reporterInterrupted).toBe(true);
        expect((yield* health.snapshot)[0]).toMatchObject({
          status: "retrying",
          nextRunAt: 90_000,
        });
        yield* TestClock.adjust("1 minute");
        expect(attempts).toBe(2);
        expect((yield* health.snapshot)[0]?.status).toBe("healthy");
        expect(logs).toHaveLength(2);
      }),
    () =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            reporterInterrupted = true;
          }),
        ),
      ),
    { logs },
  );
});

test("timeout recovery waits for slow cleanup before scheduling another pass", async () => {
  let attempts = 0;
  let active = 0;
  await withTasks(
    [
      {
        name: "cleanup",
        interval: "1 minute",
        timeout: "30 seconds",
        onFailure: "continue",
        run: () =>
          Effect.gen(function* () {
            attempts++;
            if (attempts > 1) return;
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                active++;
              }),
              () =>
                Effect.sleep("2 minutes").pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      active--;
                    }),
                  ),
                ),
            );
            yield* Effect.never;
          }),
      },
    ],
    (_stop, health) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("90 seconds");
        expect([attempts, active]).toEqual([1, 1]);
        expect((yield* health.snapshot)[0]?.status).toBe("running");
        yield* TestClock.adjust("1 minute");
        expect([attempts, active]).toEqual([1, 0]);
        expect((yield* health.snapshot)[0]).toMatchObject({
          status: "retrying",
          nextRunAt: 210_000,
          lastFailure: { kind: "timeout", at: 150_000 },
        });
        yield* TestClock.adjust("1 minute");
        expect(attempts).toBe(2);
        expect((yield* health.snapshot)[0]).toMatchObject({
          status: "healthy",
          lastSuccessAt: 210_000,
          consecutiveFailures: 0,
        });
      }),
  );
});

test("shutdown cancels an active deadline without recording a timeout or retrying", async () => {
  let attempts = 0;
  let released = 0;
  const errors: string[] = [];
  await withTasks(
    [
      {
        name: "cancelled",
        interval: "1 minute",
        timeout: "30 seconds",
        onFailure: "continue",
        run: () =>
          Effect.gen(function* () {
            attempts++;
            yield* Effect.acquireRelease(Effect.void, () =>
              Effect.sync(() => {
                released++;
              }),
            );
            yield* Effect.never;
          }),
      },
    ],
    (stop, health) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("10 seconds");
        yield* stop;
        expect(released).toBe(1);
        expect(yield* health.snapshot).toEqual([
          {
            name: "cancelled",
            status: "stopped",
            reason: "shutdown",
            lastSuccessAt: null,
            lastFailure: null,
            consecutiveFailures: 0,
          },
        ]);
        yield* TestClock.adjust("10 minutes");
        expect(attempts).toBe(1);
        expect(errors).toEqual([]);
      }),
    (error) =>
      Effect.sync(() => {
        errors.push(error.message);
      }),
  );
});

test("a task configured to stop does not retry after its deadline", async () => {
  let attempts = 0;
  await withTasks(
    [
      {
        name: "stop-timeout",
        interval: "1 minute",
        timeout: "30 seconds",
        onFailure: "stop",
        run: () =>
          Effect.sync(() => {
            attempts++;
          }).pipe(Effect.andThen(Effect.never)),
      },
    ],
    (stop, health) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("30 seconds");
        expect(yield* health.snapshot).toEqual([
          {
            name: "stop-timeout",
            status: "stopped",
            reason: "failure",
            lastSuccessAt: null,
            lastFailure: {
              at: 30_000,
              kind: "timeout",
              message: "stop-timeout exceeded its 30s deadline.",
            },
            consecutiveFailures: 1,
          },
        ]);
        yield* TestClock.adjust("10 minutes");
        expect(attempts).toBe(1);
        yield* stop;
        expect((yield* health.snapshot)[0]).toMatchObject({ status: "stopped", reason: "failure" });
      }),
  );
});

for (const timeout of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
  test(`invalid task deadline ${timeout} fails startup before login`, async () => {
    const login = spyOn(Client.prototype, "login").mockRejectedValue(new Error("Unexpected login"));
    const destroy = spyOn(Client.prototype, "destroy").mockResolvedValue(undefined);
    try {
      await expect(
        Effect.runPromise(
          Effect.scoped(
            runBot({
              token: "fixture",
              client: { intents: [] },
              modules: [
                () =>
                  Effect.succeed({
                    commands: new CommandRegistry([]),
                    events: [],
                    background: [
                      {
                        name: "invalid",
                        interval: "1 minute",
                        timeout,
                        onFailure: "continue",
                        run: () => Effect.void,
                      },
                    ],
                  }),
              ],
              ready: () => Effect.void,
              readyFailed: () => Effect.void,
              reportHandler: () => Effect.void,
              reportDiscord: () => Effect.void,
            }),
          ),
        ),
      ).rejects.toThrow();
      expect(login).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      login.mockRestore();
      destroy.mockRestore();
    }
  });
}
