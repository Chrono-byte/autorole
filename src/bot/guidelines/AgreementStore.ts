import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { asError } from "../../effectful";
import { StorageError } from "../../errors";

const decode = Schema.decodeUnknownSync(
  Schema.NullOr(
    Schema.Struct({
      guildId: Schema.String,
      memberId: Schema.String,
      messageId: Schema.String,
      agreedAt: Schema.Number,
    }),
  ),
);
const operation = <A>(name: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new StorageError({ operation: name, message: asError(cause).message, cause }),
  });

export class AgreementStore {
  private constructor(private readonly db: Database) {}

  static make = Effect.fn("AgreementStore.make")(function* (path: string) {
    const db = yield* Effect.acquireRelease(
      operation("openAgreements", () => {
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
      (resource) => Effect.sync(() => resource.close()),
    );
    yield* operation("migrateAgreements", () =>
      db.run(
        "CREATE TABLE IF NOT EXISTS guideline_agreements (guildId TEXT NOT NULL, memberId TEXT NOT NULL, messageId TEXT NOT NULL, agreedAt INTEGER NOT NULL, PRIMARY KEY (guildId, memberId, messageId))",
      ),
    );
    return new AgreementStore(db);
  });

  record(guildId: string, memberId: string, messageId: string, agreedAt: number) {
    return operation("recordAgreement", () => {
      this.db.run(
        "INSERT INTO guideline_agreements (guildId, memberId, messageId, agreedAt) VALUES (?, ?, ?, ?) ON CONFLICT(guildId, memberId, messageId) DO NOTHING",
        [guildId, memberId, messageId, agreedAt],
      );
    });
  }

  get(guildId: string, memberId: string, messageId: string) {
    return operation("getAgreement", () =>
      decode(
        this.db
          .query(
            "SELECT guildId, memberId, messageId, agreedAt FROM guideline_agreements WHERE guildId = ? AND memberId = ? AND messageId = ?",
          )
          .get(guildId, memberId, messageId),
      ),
    );
  }
}
