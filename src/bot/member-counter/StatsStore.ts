import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { openStore, operation } from "../storage";

const decode = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ guildId: Schema.String, channelId: Schema.String })),
);
export class StatsStore {
  private constructor(private readonly db: Database) {}

  static make = Effect.fn("StatsStore.make")(function* (path: string) {
    const db = yield* openStore(path, "openStats");
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
