import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DiscordAPIError,
  type Client,
  type GuildMember,
  type PartialGuildMember,
} from "discord.js";
import { Effect, Result, Schedule } from "effect";
import { tryPromise, trySync } from "../effectful";
import { logError } from "../logger";
import { RoleService } from "./RoleService";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const PENDING_RETRY_DELAY_MS = 5 * MINUTE_MS;

type Entry = {
  guildId: string;
  memberId: string;
  joinedAt: number;
  attempts: number;
  nextAttempt: number;
  screeningComplete: number;
};

export class OutstandingAssignments {
  private readonly active = new Set<string>();
  private readonly changed = new Set<string>();
  private stopped = false;

  private constructor(
    private readonly db: Database,
    private readonly client: Client,
    private readonly roles: RoleService,
    private readonly report: (
      error: unknown,
      guildId: string,
      memberId: string,
    ) => Effect.Effect<void>,
    private readonly guildId?: string,
  ) {}

  static make(
    path: string,
    client: Client,
    roles: RoleService,
    report: (error: unknown, guildId: string, memberId: string) => Effect.Effect<void>,
    guildId?: string,
  ) {
    return Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        trySync(() => {
          if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
          const database = new Database(path, { create: true });
          try {
            database.run(
              "CREATE TABLE IF NOT EXISTS assignments (guildId TEXT NOT NULL, memberId TEXT NOT NULL, joinedAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAttempt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guildId, memberId))",
            );
            const columns = database
              .query<{ name: string }, []>("PRAGMA table_info(assignments)")
              .all();
            if (!columns.some((column) => column.name === "screeningComplete"))
              database.run(
                "ALTER TABLE assignments ADD COLUMN screeningComplete INTEGER NOT NULL DEFAULT 0",
              );
            return database;
          } catch (error) {
            database.close();
            throw error;
          }
        }),
        (database) => Effect.sync(() => database.close()),
      );
      return yield* Effect.acquireRelease(
        Effect.sync(() => new OutstandingAssignments(db, client, roles, report, guildId)),
        (assignments) => assignments.stop(),
      );
    });
  }

  start() {
    return Effect.suspend(() => this.reconcile()).pipe(
      Effect.matchEffect({
        onFailure: (error) => logError("autorole_reconcile_failed", { message: error.message }),
        onSuccess: () => Effect.void,
      }),
      Effect.repeat(Schedule.spaced(MINUTE_MS)),
      Effect.asVoid,
    );
  }

  observeJoin(member: GuildMember): Effect.Effect<void, Error> {
    if (this.stopped || member.user.bot || (this.guildId && this.guildId !== member.guild.id))
      return Effect.void;
    if (member.joinedTimestamp === null)
      return this.report(new Error("Join event has no join timestamp"), member.guild.id, member.id);
    const db = this.db;
    return trySync(() =>
      db.run(
        "INSERT INTO assignments (guildId, memberId, joinedAt, screeningComplete) VALUES (?, ?, ?, ?) ON CONFLICT (guildId, memberId) DO UPDATE SET joinedAt = excluded.joinedAt, screeningComplete = excluded.screeningComplete, attempts = 0, nextAttempt = 0",
        [member.guild.id, member.id, member.joinedTimestamp, member.pending === false ? 1 : 0],
      ),
    ).pipe(Effect.andThen(this.observe(member)));
  }

  observe(member: GuildMember | PartialGuildMember): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const entry = yield* this.get(member.guild.id, member.id);
      if (!entry || this.stopped) return;
      if (member.pending === false && member.joinedTimestamp === entry.joinedAt) {
        yield* trySync(() =>
          this.db.run(
            "UPDATE assignments SET screeningComplete = 1 WHERE guildId = ? AND memberId = ? AND joinedAt = ?",
            [entry.guildId, entry.memberId, entry.joinedAt],
          ),
        );
      }
      yield* this.process(entry, true);
    });
  }

  reconcile(): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      if (this.stopped) return;
      const entries = yield* trySync(() =>
        this.db
          .query<Entry, [number]>("SELECT * FROM assignments WHERE nextAttempt <= ?")
          .all(Date.now()),
      );
      for (const entry of entries) {
        if (this.stopped) break;
        yield* this.process(entry);
      }
    });
  }

  stop(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.stopped = true;
    });
  }

  private get(guildId: string, memberId: string): Effect.Effect<Entry | null, Error> {
    return trySync(() =>
      this.db
        .query<Entry, [string, string]>(
          "SELECT * FROM assignments WHERE guildId = ? AND memberId = ?",
        )
        .get(guildId, memberId),
    );
  }

  private process(entry: Entry, observed = false): Effect.Effect<void, Error> {
    const key = `${entry.guildId}:${entry.memberId}`;
    return Effect.gen({ self: this }, function* () {
      const acquired = yield* Effect.sync(() => {
        if (this.stopped) return false;
        if (this.active.has(key)) {
          if (observed) this.changed.add(key);
          return false;
        }
        this.active.add(key);
        return true;
      });
      if (!acquired) return;
      const attempt = Effect.gen({ self: this }, function* () {
        const guild = this.client.guilds.cache.get(entry.guildId);
        if (!guild || guild.available === false)
          return yield* Effect.fail(new Error("Guild is unavailable"));
        const member = yield* tryPromise(() =>
          guild.members.fetch({ user: entry.memberId, force: true }),
        );
        if (this.stopped) return;
        if (member.joinedTimestamp !== entry.joinedAt) {
          yield* this.remove(entry);
          return;
        }
        const latest = yield* this.get(entry.guildId, entry.memberId);
        if (!latest || latest.joinedAt !== entry.joinedAt) return;
        const result = yield* this.roles.assign(member, latest.screeningComplete === 1);
        if (result === "complete") yield* this.remove(entry);
        else yield* this.defer(entry, result === "pending" ? PENDING_RETRY_DELAY_MS : undefined);
      });
      const runAttempt = Effect.gen({ self: this }, function* () {
        const result = yield* Effect.result(attempt);
        if (Result.isFailure(result)) {
          if (this.stopped) return;
          if (result.failure instanceof DiscordAPIError && result.failure.code === 10007) {
            yield* this.remove(entry);
            return;
          }
          yield* this.report(result.failure, entry.guildId, entry.memberId);
          yield* this.defer(entry);
        }
      });
      let recheck = false;
      yield* runAttempt.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.active.delete(key);
            recheck = this.changed.delete(key);
          }),
        ),
      );
      // Further Discord work must stay interruptible; finalizers only release state.
      if (recheck && !this.stopped) {
        const latest = yield* this.get(entry.guildId, entry.memberId);
        if (latest) yield* this.process(latest);
      }
    });
  }

  private remove(entry: Entry): Effect.Effect<void, Error> {
    return trySync(() =>
      this.db.run("DELETE FROM assignments WHERE guildId = ? AND memberId = ? AND joinedAt = ?", [
        entry.guildId,
        entry.memberId,
        entry.joinedAt,
      ]),
    ).pipe(Effect.asVoid);
  }

  private defer(
    entry: Entry,
    delay = Math.min(HOUR_MS, MINUTE_MS * 2 ** Math.min(entry.attempts, 6)),
  ): Effect.Effect<void, Error> {
    return trySync(() =>
      this.db.run(
        "UPDATE assignments SET attempts = attempts + 1, nextAttempt = ? WHERE guildId = ? AND memberId = ? AND joinedAt = ?",
        [Date.now() + delay, entry.guildId, entry.memberId, entry.joinedAt],
      ),
    ).pipe(Effect.asVoid);
  }
}
