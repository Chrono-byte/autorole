import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { asError } from "../effectful";
import { StorageError } from "../errors";

const decode = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ guildId: Schema.String, channelId: Schema.String })),
);
const operation = <A>(name: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new StorageError({ operation: name, message: asError(cause).message, cause }),
  });
export class StatsStore {
  private constructor(private readonly db: Database) {}

  static make = Effect.fn("StatsStore.make")(function* (path: string) {
    const db = yield* Effect.acquireRelease(
      operation("openStats", () => {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const opened = new Database(path, { create: true });
        try {
          if (path !== ":memory:") chmodSync(path, 0o600);
        } catch (e) {
          opened.close();
          throw e;
        }
        return opened;
      }),
      (resource) => Effect.sync(() => resource.close()),
    );
    yield* operation("migrateStats", () => {
      db.run(
        "CREATE TABLE IF NOT EXISTS server_stats (guildId TEXT PRIMARY KEY NOT NULL, channelId TEXT NOT NULL)",
      );
    });
    return new StatsStore(db);
  });

  list() {
    return operation("listStats", () =>
      decode(this.db.query("SELECT guildId, channelId FROM server_stats").all()),
    );
  }

  set(guildId: string, channelId: string) {
    return operation("setStats", () => {
      this.db.run(
        "INSERT INTO server_stats (guildId, channelId) VALUES (?, ?) ON CONFLICT(guildId) DO UPDATE SET channelId = excluded.channelId",
        [guildId, channelId],
      );
    });
  }
}
