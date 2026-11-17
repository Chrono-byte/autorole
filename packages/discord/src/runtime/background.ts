import { type Client } from "discord.js";
import { Cause, type Duration, Effect, Schedule } from "effect";
import { type Report } from "./events";

export type BackgroundTask = {
  name: string;
  interval: Duration.Input;
  onFailure: "continue" | "stop";
  run: (client: Client<true>) => Effect.Effect<void, Error>;
};

export function runBackgroundTask(task: BackgroundTask, client: Client<true>, report: Report) {
  const reportFailure = (error: Error, status: "retrying" | "stopped") =>
    report(error).pipe(Effect.annotateLogs({ backgroundTaskStatus: status }));
  const pass = Effect.suspend(() => task.run(client)).pipe(Effect.withSpan(task.name));
  const recover =
    task.onFailure === "continue"
      ? pass.pipe(Effect.catch((error) => reportFailure(error, "retrying")))
      : pass;
  return recover.pipe(
    Effect.repeat(Schedule.spaced(task.interval)),
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const failure = Cause.squash(cause);
      const error = failure instanceof Error ? failure : new Error(String(failure));
      return reportFailure(error, "stopped");
    }),
    Effect.annotateLogs({ backgroundTask: task.name, failurePolicy: task.onFailure }),
    Effect.asVoid,
  );
}
