import { Context, Duration, Effect, Ref } from "effect";
import { type BackgroundTask } from "./background";

export type BackgroundTaskFailure = {
  readonly at: number;
  readonly message: string;
  readonly kind: "failure" | "defect" | "timeout";
};

type TaskHistory = {
  readonly name: string;
  readonly lastSuccessAt: number | null;
  readonly lastFailure: BackgroundTaskFailure | null;
  readonly consecutiveFailures: number;
};

export type BackgroundTaskHealth = TaskHistory &
  (
    | { readonly status: "pending" }
    | { readonly status: "running"; readonly startedAt: number }
    | { readonly status: "healthy"; readonly nextRunAt: number }
    | { readonly status: "retrying"; readonly nextRunAt: number }
    | { readonly status: "stopped"; readonly reason: "failure" | "shutdown" }
  );

export class BackgroundHealth extends Context.Service<
  BackgroundHealth,
  {
    snapshot: Effect.Effect<readonly BackgroundTaskHealth[]>;
  }
>()("@autorole/discord-framework/BackgroundHealth") {}

export function taskHistory(state: BackgroundTaskHealth): TaskHistory {
  return {
    name: state.name,
    lastSuccessAt: state.lastSuccessAt,
    lastFailure: state.lastFailure,
    consecutiveFailures: state.consecutiveFailures,
  };
}

export const makeBackgroundHealth = Effect.fn("Discord.backgroundHealth")(function* () {
  const states = yield* Ref.make<readonly Ref.Ref<BackgroundTaskHealth>[]>([]);
  const snapshot = Ref.get(states).pipe(Effect.flatMap((refs) => Effect.forEach(refs, Ref.get)));
  return {
    service: BackgroundHealth.of({ snapshot }),
    register: Effect.fn("Discord.registerBackgroundTasks")(function* (
      tasks: readonly BackgroundTask[],
    ) {
      const entries = yield* Effect.forEach(tasks, (task) =>
        Effect.gen(function* () {
          const interval = yield* Effect.sync(() => Duration.fromInputUnsafe(task.interval));
          const timeout = yield* Effect.sync(() => {
            const value = Duration.fromInputUnsafe(task.timeout);
            const millis = Duration.toMillis(value);
            if (!Number.isFinite(millis) || millis <= 0)
              throw new RangeError(
                `Background task ${task.name} requires a positive finite timeout.`,
              );
            return value;
          });
          const state = yield* Ref.make<BackgroundTaskHealth>({
            name: task.name,
            status: "pending",
            lastSuccessAt: null,
            lastFailure: null,
            consecutiveFailures: 0,
          });
          return { task, interval, timeout, state };
        }),
      );
      yield* Ref.set(
        states,
        entries.map((entry) => entry.state),
      );
      return entries;
    }),
    stop: Ref.get(states).pipe(
      Effect.flatMap((refs) =>
        Effect.forEach(refs, (ref) =>
          Ref.update(ref, (state): BackgroundTaskHealth =>
            state.status === "stopped"
              ? state
              : { ...taskHistory(state), status: "stopped", reason: "shutdown" },
          ),
        ),
      ),
      Effect.asVoid,
    ),
  };
});
