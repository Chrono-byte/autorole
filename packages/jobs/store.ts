import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";

export class JobStorageError extends Schema.TaggedError<JobStorageError>()("JobStorageError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export type Job = {
  key: string;
  generation: number;
  payload: string;
  attempts: number;
  nextAttempt: number;
};

export type JobIdentity = Pick<Job, "key" | "generation">;

function operation<A>(name: string, run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) => new JobStorageError({ operation: name, cause }),
  });
}

/** SQLite-backed jobs for a single running process. Generations guard against stale work. */
export class JobStore {
  private constructor(private readonly db: Database) {}

  static make = Effect.fn("JobStore.make")(function* (
    path: string,
    migrate?: (db: Database) => void,
  ) {
    const db = yield* Effect.acquireRelease(
      operation("open", () => {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        return new Database(path, { create: true });
      }),
      (database) => Effect.sync(() => database.close()),
    );
    yield* operation("migrate", () => {
      db.transaction(() => {
        db.run(
          "CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAttempt INTEGER NOT NULL DEFAULT 0)",
        );
        migrate?.(db);
      })();
    });
    return new JobStore(db);
  });

  put(job: Pick<Job, "key" | "generation" | "payload">) {
    return operation("put", () =>
      this.db.run(
        "INSERT INTO jobs (key, generation, payload) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET generation = excluded.generation, payload = excluded.payload, attempts = 0, nextAttempt = 0",
        [job.key, job.generation, job.payload],
      ),
    );
  }

  get(key: string) {
    return operation("get", () =>
      this.db.query<Job, [string]>("SELECT * FROM jobs WHERE key = ?").get(key),
    );
  }

  due(now: number) {
    return operation("due", () =>
      this.db.query<Job, [number]>("SELECT * FROM jobs WHERE nextAttempt <= ?").all(now),
    );
  }

  patch(identity: JobIdentity, field: string, value: number) {
    return operation("patch", () =>
      this.db.run(
        "UPDATE jobs SET payload = json_set(payload, ?, ?) WHERE key = ? AND generation = ?",
        [`$.${field}`, value, identity.key, identity.generation],
      ),
    );
  }

  remove(identity: JobIdentity) {
    return operation("remove", () =>
      this.db.run("DELETE FROM jobs WHERE key = ? AND generation = ?", [
        identity.key,
        identity.generation,
      ]),
    );
  }

  defer(identity: JobIdentity, nextAttempt: number) {
    return operation("defer", () =>
      this.db.run(
        "UPDATE jobs SET attempts = attempts + 1, nextAttempt = ? WHERE key = ? AND generation = ?",
        [nextAttempt, identity.key, identity.generation],
      ),
    );
  }
}
