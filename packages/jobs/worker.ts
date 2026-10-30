import { DateTime, Effect, Schedule } from "effect";
import { JobCoordinator } from "./coordinator";

/** Runs due jobs and coalesces observations for each key in a single process. */
export class JobWorker<A, E> {
  private readonly coordinator = new JobCoordinator();

  constructor(
    private readonly options: {
      key: (job: A) => string;
      due: (now: number) => Effect.Effect<readonly A[], E>;
      reload: (job: A) => Effect.Effect<A | null, E>;
      attempt: (job: A) => Effect.Effect<void, E>;
    },
  ) {}

  get isStopped() {
    return this.coordinator.isStopped;
  }

  stop() {
    return this.coordinator.stop();
  }

  start(interval: number, report: (error: E) => Effect.Effect<void>) {
    return Effect.suspend(() => this.reconcile()).pipe(
      Effect.catch(report),
      Effect.repeat(Schedule.spaced(interval)),
      Effect.asVoid,
    );
  }

  reconcile() {
    return Effect.gen({ self: this }, function* () {
      if (this.isStopped) return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const jobs = yield* this.options.due(now);
      for (const job of jobs) {
        if (this.isStopped) break;
        yield* this.run(job);
      }
    });
  }

  run(job: A, observed = false): Effect.Effect<void, E> {
    return this.coordinator.run(this.options.key(job), observed, this.options.attempt(job), () =>
      this.options
        .reload(job)
        .pipe(Effect.flatMap((latest) => (latest ? this.run(latest) : Effect.void))),
    );
  }
}
