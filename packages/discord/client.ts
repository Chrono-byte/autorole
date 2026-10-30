import { Client, type ClientEvents, type ClientOptions } from "discord.js";
import { Effect } from "effect";

/** Acquire a Discord client for the current scope. */
export function makeClient(options: ClientOptions, close: (client: Client) => Effect.Effect<void>) {
  return Effect.acquireRelease(
    Effect.try({
      try: () => new Client(options),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
    close,
  );
}

/** Register an Effect handler whose fibers and listener belong to the current scope. */
export const listen = Effect.fn("Discord.listen")(function* <K extends keyof ClientEvents>(
  client: Client,
  event: K,
  handler: (...args: ClientEvents[K]) => Effect.Effect<void, Error>,
  report: (error: Error) => Effect.Effect<void>,
  once = false,
) {
  const scope = yield* Effect.scope;
  const runSync = Effect.runSyncWith(yield* Effect.context());
  const listener = (...args: ClientEvents[K]) => {
    runSync(
      Effect.forkIn(scope, { startImmediately: true })(handler(...args).pipe(Effect.catch(report))),
    );
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      if (once) client.once(event, listener);
      else client.on(event, listener);
    }),
    () =>
      Effect.sync(() => {
        client.off(event, listener);
      }),
  );
});
