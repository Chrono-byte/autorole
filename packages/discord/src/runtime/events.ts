import {
  Events,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ClientEvents,
} from "discord.js";
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

function runInteraction(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  run: () => Effect.Effect<void, Error>,
  report: Report,
  defaultError?: string,
) {
  return Effect.try({
    try: run,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.flatMap((handler) => handler),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const failure = Cause.squash(cause);
      const error = failure instanceof Error ? failure : new Error(String(failure));
      const message = error instanceof PermissionDenied ? error.message : defaultError;
      const log = error instanceof PermissionDenied ? Effect.void : report(error);
      return log.pipe(
        Effect.andThen(notifyCommandFailure(interaction, message).pipe(Effect.catch(report))),
      );
    }),
  );
}

/** Install button interactions with the same scoped lifecycle and error handling as commands. */
export function buttonEvent(
  matches: (interaction: ButtonInteraction) => boolean,
  run: (interaction: ButtonInteraction) => Effect.Effect<void, Error>,
): EventHandler {
  return (client, report) =>
    listen(
      client,
      Events.InteractionCreate,
      (interaction) => {
        if (!interaction.isButton()) return Effect.void;
        return runInteraction(
          interaction,
          () => (matches(interaction) ? run(interaction) : Effect.void),
          report,
          "Something went wrong. Please try again.",
        );
      },
      report,
    );
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
      return runInteraction(interaction, () => commands.dispatch(interaction), report);
    },
    report,
  );
  for (const handler of events) yield* handler(client, report);
});
