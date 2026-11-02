import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { asError } from "../../effectful";
import { StorageError } from "../../errors";

const Entry = Schema.Struct({ userId: Schema.String, threadId: Schema.String });
const MessageLink = Schema.Struct({
  threadId: Schema.String,
  sourceId: Schema.String,
  sourceChannelId: Schema.String,
  authorId: Schema.String,
  destinationId: Schema.String,
  destinationChannelId: Schema.String,
  webhookId: Schema.NullOr(Schema.String),
});
const decodeLink = Schema.decodeUnknownSync(Schema.NullOr(MessageLink));
const Controls = Schema.Array(
  Schema.Struct({ channelId: Schema.String, messageId: Schema.String }),
);
const decodeControls = Schema.decodeUnknownSync(Controls);
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
    yield* operation("migrateSuggestionHistory", () =>
      database.run(
        "CREATE TABLE IF NOT EXISTS suggestion_history (userId TEXT PRIMARY KEY NOT NULL, threadId TEXT UNIQUE NOT NULL)",
      ),
    );
    yield* operation("migrateSuggestionConversations", () => {
      database.run(
        "CREATE TABLE IF NOT EXISTS suggestion_conversations (threadId TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL)",
      );
      database.run(
        "INSERT OR IGNORE INTO suggestion_conversations SELECT threadId, userId FROM suggestion_history",
      );
      database.run(
        "INSERT OR IGNORE INTO suggestion_conversations SELECT threadId, userId FROM active_suggestions",
      );
      database.run(
        "CREATE TABLE IF NOT EXISTS suggestion_messages (sourceId TEXT PRIMARY KEY NOT NULL, threadId TEXT NOT NULL, sourceChannelId TEXT NOT NULL, authorId TEXT NOT NULL, destinationId TEXT UNIQUE NOT NULL, destinationChannelId TEXT NOT NULL, webhookId TEXT)",
      );
      if (
        !database
          .query(
            "SELECT name FROM pragma_table_info('suggestion_messages') WHERE name = 'webhookId'",
          )
          .get()
      ) {
        database.run("ALTER TABLE suggestion_messages ADD COLUMN webhookId TEXT");
      }
      database.run(
        "CREATE TABLE IF NOT EXISTS suggestion_controls (messageId TEXT PRIMARY KEY NOT NULL, channelId TEXT NOT NULL, threadId TEXT NOT NULL)",
      );
    });
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

  remember(userId: string, threadId: string) {
    return operation("rememberSuggestion", () =>
      this.database.run(
        "INSERT OR IGNORE INTO suggestion_conversations (userId, threadId) VALUES (?, ?)",
        [userId, threadId],
      ),
    );
  }

  getConversation(threadId: string) {
    return operation("getSuggestionConversation", () =>
      decode(
        this.database
          .query("SELECT userId, threadId FROM suggestion_conversations WHERE threadId = ?")
          .get(threadId),
      ),
    );
  }

  put(userId: string, threadId: string) {
    return operation("putSuggestion", () =>
      this.database.transaction(() => {
        this.database.run("INSERT INTO active_suggestions (userId, threadId) VALUES (?, ?)", [
          userId,
          threadId,
        ]);
        this.database.run(
          "INSERT OR IGNORE INTO suggestion_conversations (userId, threadId) VALUES (?, ?)",
          [userId, threadId],
        );
      })(),
    );
  }

  linkMessage(link: Omit<typeof MessageLink.Type, "webhookId"> & { webhookId?: string }) {
    return operation("linkSuggestionMessage", () =>
      this.database.run(
        "INSERT INTO suggestion_messages (threadId, sourceId, sourceChannelId, authorId, destinationId, destinationChannelId, webhookId) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          link.threadId,
          link.sourceId,
          link.sourceChannelId,
          link.authorId,
          link.destinationId,
          link.destinationChannelId,
          link.webhookId ?? null,
        ],
      ),
    );
  }

  getMessage(id: string) {
    return operation("getSuggestionMessage", () =>
      decodeLink(
        this.database
          .query("SELECT * FROM suggestion_messages WHERE sourceId = ? OR destinationId = ?")
          .get(id, id),
      ),
    );
  }

  trackControls(threadId: string, channelId: string, messageId: string) {
    return operation("trackSuggestionControls", () =>
      this.database.run(
        "INSERT OR IGNORE INTO suggestion_controls (threadId, channelId, messageId) VALUES (?, ?, ?)",
        [threadId, channelId, messageId],
      ),
    );
  }

  getControls(threadId: string) {
    return operation("getSuggestionControls", () =>
      decodeControls(
        this.database
          .query("SELECT channelId, messageId FROM suggestion_controls WHERE threadId = ?")
          .all(threadId),
      ),
    );
  }

  getPrevious(userId: string) {
    return operation("getPreviousSuggestion", () =>
      decode(
        this.database
          .query("SELECT userId, threadId FROM suggestion_history WHERE userId = ?")
          .get(userId),
      ),
    );
  }

  close(userId: string, threadId: string) {
    return operation("closeSuggestion", () =>
      this.database.transaction(() => {
        this.database.run(
          "INSERT OR REPLACE INTO suggestion_history (userId, threadId) VALUES (?, ?)",
          [userId, threadId],
        );
        this.database.run("DELETE FROM active_suggestions WHERE userId = ? AND threadId = ?", [
          userId,
          threadId,
        ]);
      })(),
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
