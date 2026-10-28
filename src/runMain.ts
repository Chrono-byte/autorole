import { Effect, type Scope } from "effect";
import { asError } from "./effectful";
import { logError } from "./logger";

// Entrypoints own process signals; interruption then closes all scoped resources.
export async function runMain(
  program: Effect.Effect<void, Error, Scope.Scope>,
  failureEvent: string,
) {
  const shutdown = new AbortController();
  const onSignal = () => shutdown.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await Effect.runPromise(Effect.scoped(program), { signal: shutdown.signal });
  } catch (error) {
    if (!shutdown.signal.aborted) {
      process.exitCode = 1;
      await Effect.runPromise(logError(failureEvent, { message: asError(error).message }));
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
