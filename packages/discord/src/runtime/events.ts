import { Events, type Client, type ClientEvents } from "discord.js";
import { Cause, Effect } from "effect";
import { CommandRegistry } from "../commands/registry";
import { PermissionDenied } from "../commands/permissions";
import { notifyCommandFailure } from "../commands/response";
import { listen } from "./client";

export type Report = (error: Error) => Effect.Effect<void>;
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
    (interaction) => {
      if (!interaction.isChatInputCommand()) return Effect.void;
      return Effect.try({
        try: () => commands.dispatch(interaction),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(
        Effect.flatMap((handler) => handler),
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
          const failure = Cause.squash(cause);
          const error = failure instanceof Error ? failure : new Error(String(failure));
          const message = error instanceof PermissionDenied ? error.message : undefined;
          const log = error instanceof PermissionDenied ? Effect.void : report(error);
          return log.pipe(
            Effect.andThen(notifyCommandFailure(interaction, message).pipe(Effect.catch(report))),
          );
        }),
      );
    },
    report,
  );
  for (const handler of events) yield* handler(client, report);
});
