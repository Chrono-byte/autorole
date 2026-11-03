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
    yield* operation("migrateAgreementPeriods", () => {
      db.run(
        "CREATE TABLE IF NOT EXISTS guideline_periods (id TEXT PRIMARY KEY, guildId TEXT NOT NULL, channelId TEXT NOT NULL, messageId TEXT NOT NULL, period TEXT NOT NULL, version TEXT NOT NULL, startedAt INTEGER NOT NULL)",
      );
      db.run(
        "CREATE TABLE IF NOT EXISTS guideline_period_acceptances (periodId TEXT NOT NULL, memberId TEXT NOT NULL, agreedAt INTEGER NOT NULL, PRIMARY KEY(periodId, memberId), FOREIGN KEY(periodId) REFERENCES guideline_periods(id))",
      );
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
        "INSERT INTO guideline_period_acceptances (periodId, memberId, agreedAt) SELECT p.id, ?, ? FROM guideline_periods p JOIN guideline_active_period a ON a.periodId = p.id WHERE p.id = ? AND p.guildId = ? AND p.channelId = ? AND p.messageId = ? ON CONFLICT(periodId, memberId) DO NOTHING",
        [memberId, agreedAt, periodId, guildId, channelId, messageId],
      );
      return result.changes > 0;
    });
  }

  getAcceptance(periodId: string, memberId: string) {
    return operation("getPeriodAcceptance", () =>
      Schema.decodeUnknownSync(
        Schema.NullOr(
          Schema.Struct({
            periodId: Schema.String,
            memberId: Schema.String,
            agreedAt: Schema.Number,
          }),
        ),
      )(
        this.db
          .query(
            "SELECT periodId, memberId, agreedAt FROM guideline_period_acceptances WHERE periodId = ? AND memberId = ?",
          )
          .get(periodId, memberId),
      ),
    );
  }

  history(guildId: string, memberId: string) {
    return operation("agreementHistory", () =>
      Schema.decodeUnknownSync(
        Schema.Array(
          Schema.Struct({ period: Schema.String, version: Schema.String, agreedAt: Schema.Number }),
        ),
      )(
        this.db
          .query(
            "SELECT p.period, p.version, a.agreedAt FROM guideline_period_acceptances a JOIN guideline_periods p ON p.id = a.periodId WHERE p.guildId = ? AND a.memberId = ? ORDER BY a.agreedAt DESC LIMIT 25",
          )
          .all(guildId, memberId),
      ),
    );
  }

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
