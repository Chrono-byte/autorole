import { expect, spyOn, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { journalLoggerLayer, logError, logInfo } from "../src/logger";

test("Effect logging preserves journal priorities, metadata, and tracing", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* logInfo("autorole_connected", { user: "Athena", omitted: undefined });
        yield* logError("autorole_assignment_error", { message: "Unavailable" });
      }).pipe(
        Effect.annotateLogs({ guildId: "guild" }),
        Effect.withSpan("logging-test"),
        Effect.provide(journalLoggerLayer),
      ),
    );
    expect(output).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(output[0]).toStartWith("<6>autorole_connected ");
    expect(errors[0]).toStartWith("<3>autorole_assignment_error ");
    expect(output[0]).toContain('user="Athena"');
    expect(output[0]).toContain('guildId="guild"');
    expect(output[0]).not.toContain("omitted=");
    expect(output[0]).toMatch(/fiberId="#[0-9]+"/);
    expect(output[0]).toContain('traceId="');
    expect(output[0]).toContain('spanId="');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("callback fibers retain the installed logger and inherited annotations", async () => {
  const output: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const runSync = Effect.runSyncWith(yield* Effect.context());
          const callback = () =>
            runSync(
              Effect.forkIn(scope, { startImmediately: true })(logInfo("callback_event", {})),
            );
          yield* Fiber.join(callback());
        }),
      ).pipe(Effect.annotateLogs({ guildId: "guild" }), Effect.provide(journalLoggerLayer)),
    );
    expect(output).toHaveLength(1);
    expect(output[0]).toStartWith("<6>callback_event ");
    expect(output[0]).toContain('guildId="guild"');
  } finally {
    stdout.mockRestore();
  }
});
