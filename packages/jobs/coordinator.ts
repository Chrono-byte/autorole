import { Effect } from "effect";

/** Coalesces observations while a job with the same key is running. */
export class JobCoordinator {
  private readonly active = new Set<string>();
  private readonly changed = new Set<string>();
  private stopped = false;

  get isStopped() {
    return this.stopped;
  }

  stop() {
    return Effect.sync(() => {
      this.stopped = true;
    });
  }

  run<E>(
    key: string,
    observed: boolean,
    attempt: Effect.Effect<void, E>,
    recheck: () => Effect.Effect<void, E>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const acquired = yield* Effect.sync(() => {
        if (this.stopped) return false;
        if (this.active.has(key)) {
          if (observed) this.changed.add(key);
          return false;
        }
        this.active.add(key);
        return true;
      });
      if (!acquired) return;
      let changed = false;
      yield* attempt.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.active.delete(key);
            changed = this.changed.delete(key);
          }),
        ),
      );
      if (changed && !this.stopped) yield* recheck();
    });
  }
}
