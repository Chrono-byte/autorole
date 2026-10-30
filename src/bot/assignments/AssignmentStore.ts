import { Effect, Schema } from "effect";
import { JobStorageError, JobStore, type Job } from "../../../packages/jobs/store";
import { asError } from "../../effectful";
import { StorageError } from "../../errors";

const Assignment = Schema.Struct({
  guildId: Schema.String,
  memberId: Schema.String,
  joinedAt: Schema.Number,
  attempts: Schema.Number,
  nextAttempt: Schema.Number,
  screeningComplete: Schema.Number,
});
export type Assignment = typeof Assignment.Type;
export type AssignmentIdentity = Pick<Assignment, "guildId" | "memberId" | "joinedAt">;
export type ObservedJoin = AssignmentIdentity & Pick<Assignment, "screeningComplete">;
const decodeAssignment = Schema.decodeUnknownSync(Assignment);
export const assignmentKey = (guildId: string, memberId: string) =>
  JSON.stringify([guildId, memberId]);
const identity = (entry: AssignmentIdentity) => ({
  key: assignmentKey(entry.guildId, entry.memberId),
  generation: entry.joinedAt,
});
const decode = (job: Job) =>
  decodeAssignment({
    ...JSON.parse(job.payload),
    joinedAt: job.generation,
    attempts: job.attempts,
    nextAttempt: job.nextAttempt,
  });

function storageError(operation: string, error: unknown) {
  const cause = error instanceof JobStorageError ? error.cause : error;
  return new StorageError({ operation, cause, message: asError(cause).message });
}

function storageOperation<A>(operation: string, effect: Effect.Effect<A, unknown>) {
  return effect.pipe(Effect.mapError((error) => storageError(operation, error)));
}

export class AssignmentStore {
  private constructor(private readonly jobs: JobStore) {}

  static make = Effect.fn("AssignmentStore.make")(function* (path: string) {
    const jobs = yield* JobStore.make(path, (db) => {
      const exists = db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assignments'")
        .get();
      if (exists && db.query("SELECT 1 FROM assignments LIMIT 1").get())
        throw new Error(
          "Legacy assignments table found. Migrate or reconcile it before starting the bot.",
        );
    }).pipe(Effect.mapError((error) => storageError(error.operation, error)));
    return new AssignmentStore(jobs);
  });

  recordJoin(join: ObservedJoin) {
    return storageOperation(
      "recordJoin",
      this.jobs.put({
        ...identity(join),
        payload: JSON.stringify({
          guildId: join.guildId,
          memberId: join.memberId,
          screeningComplete: join.screeningComplete,
        }),
      }),
    );
  }

  get(guildId: string, memberId: string) {
    return storageOperation(
      "get",
      this.jobs
        .get(assignmentKey(guildId, memberId))
        .pipe(Effect.flatMap((job) => Effect.try(() => (job === null ? null : decode(job))))),
    );
  }

  due(now: number) {
    return storageOperation(
      "due",
      this.jobs.due(now).pipe(Effect.flatMap((jobs) => Effect.try(() => jobs.map(decode)))),
    );
  }

  completeScreening(entry: AssignmentIdentity) {
    return storageOperation(
      "completeScreening",
      this.jobs.patch(identity(entry), "screeningComplete", 1),
    );
  }

  remove(entry: AssignmentIdentity) {
    return storageOperation("remove", this.jobs.remove(identity(entry)));
  }

  defer(entry: AssignmentIdentity, nextAttempt: number) {
    return storageOperation("defer", this.jobs.defer(identity(entry), nextAttempt));
  }
}
