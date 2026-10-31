import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { asError } from "../../effectful";
import { StorageError } from "../../errors";

const Entry = Schema.Struct({ userId: Schema.String, threadId: Schema.String });
const decode = Schema.decodeUnknownSync(Schema.NullOr(Entry));

function operation<A>(name: string, run: () => A) {
  return Effect.try({
    try: run,
    catch: (cause) => new StorageError({ operation: name, message: asError(cause).message, cause }),
  });
}

export class SuggestionStore {
  private constructor(private readonly database: Database) {}

  static make = Effect.fn("SuggestionStore.make")(function* (path: string) {
    const database = yield* Effect.acquireRelease(
      operation("openSuggestions", () => {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const opened = new Database(path, { create: true });
        try {
          if (path !== ":memory:") chmodSync(path, 0o600);
        } catch (error) {
          opened.close();
          throw error;
        }
        return opened;
      }),
      (db) => Effect.sync(() => db.close()),
    );
    yield* operation("migrateSuggestions", () =>
      database.run(
        "CREATE TABLE IF NOT EXISTS active_suggestions (userId TEXT PRIMARY KEY NOT NULL, threadId TEXT UNIQUE NOT NULL)",
      ),
    );
    return new SuggestionStore(database);
  });

  getByUser(userId: string) {
    return operation("getSuggestionByUser", () =>
      decode(
        this.database
          .query("SELECT userId, threadId FROM active_suggestions WHERE userId = ?")
          .get(userId),
      ),
    );
  }

  getByThread(threadId: string) {
    return operation("getSuggestionByThread", () =>
      decode(
        this.database
          .query("SELECT userId, threadId FROM active_suggestions WHERE threadId = ?")
          .get(threadId),
      ),
    );
  }

  put(userId: string, threadId: string) {
    return operation("putSuggestion", () =>
      this.database.run("INSERT INTO active_suggestions (userId, threadId) VALUES (?, ?)", [
        userId,
        threadId,
      ]),
    );
  }

  remove(userId: string, threadId: string) {
    return operation("removeSuggestion", () =>
      this.database.run("DELETE FROM active_suggestions WHERE userId = ? AND threadId = ?", [
        userId,
        threadId,
      ]),
    );
  }
}
