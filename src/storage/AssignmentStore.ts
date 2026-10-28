import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { asError } from "../effectful";
import { StorageError } from "../errors";

const Assignment = Schema.Struct({
  guildId: Schema.String,
  memberId: Schema.String,
  joinedAt: Schema.Number,
  attempts: Schema.Number,
  nextAttempt: Schema.Number,
  screeningComplete: Schema.Number,
});
export type Assignment = typeof Assignment.Type;
export type ObservedJoin = Pick<
  Assignment,
  "guildId" | "memberId" | "joinedAt" | "screeningComplete"
>;
const decodeAssignment = Schema.decodeUnknownSync(Assignment);
const decodeAssignments = Schema.decodeUnknownSync(Schema.Array(Assignment));

function storageOperation<A>(operation: string, run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) => new StorageError({ operation, cause, message: asError(cause).message }),
  });
}

export class AssignmentStore {
  private constructor(private readonly db: Database) {}

  static make = Effect.fn("AssignmentStore.make")(function* (path: string) {
    const db = yield* Effect.acquireRelease(
      storageOperation("open", () => {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        return new Database(path, { create: true });
      }),
      (database) => Effect.sync(() => database.close()),
    );
    yield* storageOperation("migrate", () => {
      db.transaction(() => {
        db.run(
          "CREATE TABLE IF NOT EXISTS assignments (guildId TEXT NOT NULL, memberId TEXT NOT NULL, joinedAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAttempt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guildId, memberId))",
        );
        const columns = db.query<{ name: string }, []>("PRAGMA table_info(assignments)").all();
        if (!columns.some((column) => column.name === "screeningComplete"))
          db.run("ALTER TABLE assignments ADD COLUMN screeningComplete INTEGER NOT NULL DEFAULT 0");
      })();
    });
    return new AssignmentStore(db);
  });

  recordJoin(join: ObservedJoin) {
    return storageOperation("recordJoin", () => {
      this.db.run(
        "INSERT INTO assignments (guildId, memberId, joinedAt, screeningComplete) VALUES (?, ?, ?, ?) ON CONFLICT (guildId, memberId) DO UPDATE SET joinedAt = excluded.joinedAt, screeningComplete = excluded.screeningComplete, attempts = 0, nextAttempt = 0",
        [join.guildId, join.memberId, join.joinedAt, join.screeningComplete],
      );
    });
  }

  get(guildId: string, memberId: string) {
    return storageOperation("get", () => {
      const row = this.db
        .query("SELECT * FROM assignments WHERE guildId = ? AND memberId = ?")
        .get(guildId, memberId);
      return row === null ? null : decodeAssignment(row);
    });
  }

  due(now: number) {
    return storageOperation("due", () =>
      decodeAssignments(this.db.query("SELECT * FROM assignments WHERE nextAttempt <= ?").all(now)),
    );
  }

  completeScreening(entry: Assignment) {
    return storageOperation("completeScreening", () => {
      this.db.run(
        "UPDATE assignments SET screeningComplete = 1 WHERE guildId = ? AND memberId = ? AND joinedAt = ?",
        [entry.guildId, entry.memberId, entry.joinedAt],
      );
    });
  }

  remove(entry: Assignment) {
    return storageOperation("remove", () => {
      this.db.run("DELETE FROM assignments WHERE guildId = ? AND memberId = ? AND joinedAt = ?", [
        entry.guildId,
        entry.memberId,
        entry.joinedAt,
      ]);
    });
  }

  defer(entry: Assignment, nextAttempt: number) {
    return storageOperation("defer", () => {
      this.db.run(
        "UPDATE assignments SET attempts = attempts + 1, nextAttempt = ? WHERE guildId = ? AND memberId = ? AND joinedAt = ?",
        [nextAttempt, entry.guildId, entry.memberId, entry.joinedAt],
      );
    });
  }
}
