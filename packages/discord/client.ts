import { Client, type ClientEvents, type ClientOptions } from "discord.js";
import { Effect } from "effect";
import { discordRequest } from "./request";

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

/** Acquire a client, install its behavior, log in, and stay alive until stopped. */
export const runClient = Effect.fn("Discord.runClient")(function* (
  options: ClientOptions,
  token: string,
  setup: (client: Client) => Effect.Effect<void, Error, import("effect").Scope.Scope>,
  until: Effect.Effect<void> = Effect.never,
) {
  const client = yield* makeClient(options, (discordClient) =>
    discordRequest(() => discordClient.destroy()).pipe(Effect.ignore),
  );
  yield* setup(client);
  yield* discordRequest(() => client.login(token));
  yield* until;
});
