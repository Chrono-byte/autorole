import { type Client } from "discord.js";
import { Cause, DateTime, Duration, Effect, Exit, Ref, Schema, type Scope } from "effect";
import { type Report } from "./events";
import { taskHistory, type BackgroundTaskHealth } from "./health";

export type BackgroundTask = {
  name: string;
  interval: Duration.Input;
  timeout: Duration.Input;
  onFailure: "continue" | "stop";
  run: (client: Client<true>) => Effect.Effect<void, Error, Scope.Scope>;
};

export class BackgroundTaskTimeout extends Schema.TaggedError<BackgroundTaskTimeout>()(
  "BackgroundTaskTimeout",
  {
    task: Schema.String,
    timeoutMs: Schema.Number,
    message: Schema.String,
  },
) {}

const reportingTimeout = Duration.seconds(30);

export const runBackgroundTask = Effect.fn("Discord.backgroundTask")(
  function* (options: {
    task: BackgroundTask;
    interval: Duration.Duration;
    timeout: Duration.Duration;
    state: Ref.Ref<BackgroundTaskHealth>;
    client: Client<true>;
    report: Report;
  }) {
    const { task, interval, timeout, state, client, report } = options;
    const delay = Duration.toMillis(interval);
    while (true) {
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
      yield* Ref.update(state, (current): BackgroundTaskHealth => ({
        ...taskHistory(current),
        status: "running",
        startedAt,
      }));
      const result = yield* Effect.exit(
        Effect.scoped(Effect.suspend(() => task.run(client))).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new BackgroundTaskTimeout({
                  task: task.name,
                  timeoutMs: Duration.toMillis(timeout),
                  message: `${task.name} exceeded its ${Duration.format(timeout)} deadline.`,
                }),
              ),
          }),
          Effect.withSpan(task.name),
        ),
      );
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const previous = yield* Ref.get(state);
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause);
        const failure = Cause.squash(result.cause);
        const error = failure instanceof Error ? failure : new Error(String(failure));
        const history = {
          ...taskHistory(previous),
          lastFailure: {
            at: now,
            message: error.message,
            kind:
              error instanceof BackgroundTaskTimeout
                ? ("timeout" as const)
                : Cause.hasDies(result.cause)
                  ? ("defect" as const)
                  : ("failure" as const),
          },
          consecutiveFailures: previous.consecutiveFailures + 1,
        };
        yield* Ref.set(
          state,
          task.onFailure === "continue"
            ? { ...history, status: "retrying", nextRunAt: now + delay }
            : { ...history, status: "stopped", reason: "failure" },
        );
        yield* Effect.suspend(() => report(error)).pipe(
          Effect.timeout(reportingTimeout),
          Effect.annotateLogs({
            backgroundTaskStatus: task.onFailure === "continue" ? "retrying" : "stopped",
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logError("background_report_failed", cause),
          ),
        );
        if (task.onFailure === "stop") return;
        const scheduledAt = DateTime.toEpochMillis(yield* DateTime.now);
        yield* Ref.set(state, { ...history, status: "retrying", nextRunAt: scheduledAt + delay });
      } else {
        yield* Ref.set(state, {
          ...taskHistory(previous),
          status: "healthy",
          nextRunAt: now + delay,
          lastSuccessAt: now,
          consecutiveFailures: 0,
        });
        if (previous.consecutiveFailures > 0)
          yield* Effect.logInfo("background_task_recovered").pipe(
            Effect.annotateLogs({
              consecutiveFailures: previous.consecutiveFailures,
            }),
          );
      }
      yield* Effect.sleep(interval);
    }
  },
  (effect, { task, state }) =>
    effect.pipe(
      Effect.onInterrupt(() =>
        Ref.update(state, (current): BackgroundTaskHealth =>
          current.status === "stopped"
            ? current
            : { ...taskHistory(current), status: "stopped", reason: "shutdown" },
        ),
      ),
      Effect.annotateLogs({ backgroundTask: task.name, failurePolicy: task.onFailure }),
    ),
);
