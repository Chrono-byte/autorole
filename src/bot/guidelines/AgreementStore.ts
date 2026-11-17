import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { openStore, operation } from "../storage";

export class AgreementStore {
  private constructor(private readonly db: Database) {}

  static make = Effect.fn("AgreementStore.make")(function* (path: string) {
    const db = yield* openStore(path, "openAgreements");
    yield* operation("migrateAgreementPeriods", () => {
      db.run(
        "CREATE TABLE IF NOT EXISTS guideline_periods (id TEXT PRIMARY KEY, guildId TEXT NOT NULL, channelId TEXT NOT NULL, messageId TEXT NOT NULL, period TEXT NOT NULL, version TEXT NOT NULL, startedAt INTEGER NOT NULL)",
      );
      db.run(
        "CREATE TABLE IF NOT EXISTS guideline_period_acceptances (periodId TEXT NOT NULL, memberId TEXT NOT NULL, agreedAt INTEGER NOT NULL, PRIMARY KEY(periodId, memberId), FOREIGN KEY(periodId) REFERENCES guideline_periods(id))",
      );
      if (
        !db
          .query(
            "SELECT name FROM pragma_table_info('guideline_period_acceptances') WHERE name = 'source'",
          )
          .get()
      ) {
        db.run(
          "ALTER TABLE guideline_period_acceptances ADD COLUMN source TEXT NOT NULL DEFAULT 'member' CHECK(source IN ('member', 'admin'))",
        );
      }
      db.run(
        "CREATE TABLE IF NOT EXISTS guideline_active_period (guildId TEXT PRIMARY KEY, periodId TEXT NOT NULL, FOREIGN KEY(periodId) REFERENCES guideline_periods(id))",
      );
    });
    return new AgreementStore(db);
  });

  deactivate(guildId: string) {
    return operation("deactivateAgreementPeriod", () => {
      this.db.run("DELETE FROM guideline_active_period WHERE guildId = ?", [guildId]);
    });
  }

  startPeriod(input: {
    id: string;
    guildId: string;
    channelId: string;
    messageId: string;
    period: string;
    version: string;
    startedAt: number;
  }) {
    return operation("startAgreementPeriod", () =>
      this.db.transaction(() => {
        this.db.run(
          "INSERT INTO guideline_periods (id, guildId, channelId, messageId, period, version, startedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            input.id,
            input.guildId,
            input.channelId,
            input.messageId,
            input.period,
            input.version,
            input.startedAt,
          ],
        );
        this.db.run(
          "INSERT INTO guideline_active_period (guildId, periodId) VALUES (?, ?) ON CONFLICT(guildId) DO UPDATE SET periodId = excluded.periodId",
          [input.guildId, input.id],
        );
      })(),
    );
  }

  active(guildId: string) {
    return operation("activeAgreementPeriod", () =>
      Schema.decodeUnknownSync(
        Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            guildId: Schema.String,
            channelId: Schema.String,
            messageId: Schema.String,
            period: Schema.String,
            version: Schema.String,
            startedAt: Schema.Number,
          }),
        ),
      )(
        this.db
          .query(
            "SELECT p.* FROM guideline_periods p JOIN guideline_active_period a ON a.periodId = p.id WHERE a.guildId = ?",
          )
          .get(guildId),
      ),
    );
  }

  acceptCurrent(
    guildId: string,
    periodId: string,
    channelId: string,
    messageId: string,
    memberId: string,
    agreedAt: number,
  ) {
    return operation("acceptAgreementPeriod", () => {
      const result = this.db.run(
        "INSERT INTO guideline_period_acceptances (periodId, memberId, agreedAt) SELECT p.id, ?, ? FROM guideline_periods p JOIN guideline_active_period a ON a.periodId = p.id WHERE p.id = ? AND p.guildId = ? AND p.channelId = ? AND p.messageId = ? ON CONFLICT(periodId, memberId) DO UPDATE SET agreedAt = excluded.agreedAt, source = 'member' WHERE guideline_period_acceptances.source = 'admin'",
        [memberId, agreedAt, periodId, guildId, channelId, messageId],
      );
      return result.changes > 0;
    });
  }

  grantCurrent(guildId: string, periodId: string, memberIds: readonly string[], grantedAt: number) {
    return operation("grantAgreementAccess", () =>
      this.db.transaction(() => {
        let changes = 0;
        for (const memberId of memberIds) {
          changes += this.db.run(
            "INSERT INTO guideline_period_acceptances (periodId, memberId, agreedAt, source) SELECT p.id, ?, ?, 'admin' FROM guideline_periods p JOIN guideline_active_period a ON a.periodId = p.id WHERE p.id = ? AND p.guildId = ? ON CONFLICT(periodId, memberId) DO NOTHING",
            [memberId, grantedAt, periodId, guildId],
          ).changes;
        }
        return changes;
      })(),
    );
  }

  getAcceptance(periodId: string, memberId: string) {
    return operation("getPeriodAcceptance", () =>
      Schema.decodeUnknownSync(
        Schema.NullOr(
          Schema.Struct({
            periodId: Schema.String,
            memberId: Schema.String,
            agreedAt: Schema.Number,
            source: Schema.Literals(["member", "admin"]),
          }),
        ),
      )(
        this.db
          .query(
            "SELECT periodId, memberId, agreedAt, source FROM guideline_period_acceptances WHERE periodId = ? AND memberId = ?",
          )
          .get(periodId, memberId),
      ),
    );
  }

  history(guildId: string, memberId: string) {
    return operation("agreementHistory", () =>
      Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({
            period: Schema.String,
            version: Schema.String,
            agreedAt: Schema.Number,
            source: Schema.Literals(["member", "admin"]),
          }),
        ),
      )(
        this.db
          .query(
            "SELECT p.period, p.version, a.agreedAt, a.source FROM guideline_period_acceptances a JOIN guideline_periods p ON p.id = a.periodId WHERE p.guildId = ? AND a.memberId = ? ORDER BY a.agreedAt DESC",
          )
          .all(guildId, memberId),
      ),
    );
  }
}
