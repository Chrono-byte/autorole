import { type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { DateTime, Effect, Schedule } from "effect";
import { ConfigurationError, DiscordRequestError, StorageError, discordRequest } from "../errors";
import { logError } from "../logger";
import { AssignmentStore, type Assignment } from "../storage/AssignmentStore";
import { RoleService } from "./RoleService";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SCREENING_RECHECK_MS = 5 * MINUTE_MS;
const CONFIGURATION_RECHECK_MS = 5 * MINUTE_MS;

export class OutstandingAssignments {
  private readonly active = new Set<string>();
  private readonly changed = new Set<string>();
  private stopped = false;

  private constructor(
    private readonly store: AssignmentStore,
    private readonly client: Client,
    private readonly roles: RoleService,
    private readonly report: (
      error: unknown,
      guildId: string,
      memberId: string,
    ) => Effect.Effect<void>,
    private readonly guildId?: string,
  ) {}

  static make = Effect.fn("OutstandingAssignments.make")(function* (
    path: string,
    client: Client,
    roles: RoleService,
    report: (error: unknown, guildId: string, memberId: string) => Effect.Effect<void>,
    guildId?: string,
  ) {
    const store = yield* AssignmentStore.make(path);
    return yield* Effect.acquireRelease(
      Effect.sync(() => new OutstandingAssignments(store, client, roles, report, guildId)),
      (assignments) => assignments.stop(),
    );
  });

  start() {
    return Effect.suspend(() => this.reconcile()).pipe(
      Effect.catchTag("StorageError", (error) =>
        logError("autorole_reconcile_failed", {
          operation: error.operation,
          message: error.message,
        }),
      ),
      Effect.repeat(Schedule.spaced(MINUTE_MS)),
      Effect.asVoid,
    );
  }

  observeJoin = Effect.fn("OutstandingAssignments.observeJoin")(function* (
    this: OutstandingAssignments,
    member: GuildMember,
  ) {
    if (this.stopped || member.user.bot || (this.guildId && this.guildId !== member.guild.id))
      return;
    if (member.joinedTimestamp === null) {
      yield* this.report(
        new ConfigurationError({ message: "Join event has no join timestamp" }),
        member.guild.id,
        member.id,
      );
      return;
    }
    yield* this.store.recordJoin({
      guildId: member.guild.id,
      memberId: member.id,
      joinedAt: member.joinedTimestamp,
      screeningComplete: member.pending === false ? 1 : 0,
    });
    yield* this.observe(member);
  });

  observe = Effect.fn("OutstandingAssignments.observe")(function* (
    this: OutstandingAssignments,
    member: GuildMember | PartialGuildMember,
  ): Effect.fn.Return<void, StorageError> {
    if (this.stopped) return;
    const entry = yield* this.store.get(member.guild.id, member.id);
    if (!entry) return;
    if (member.pending === false && member.joinedTimestamp === entry.joinedAt)
      yield* this.store.completeScreening(entry);
    yield* this.process(entry, true);
  });

  reconcile = Effect.fn("OutstandingAssignments.reconcile")(function* (
    this: OutstandingAssignments,
  ): Effect.fn.Return<void, StorageError> {
    if (this.stopped) return;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const entries = yield* this.store.due(now);
    for (const entry of entries) {
      if (this.stopped) break;
      yield* this.process(entry);
    }
  });

  stop() {
    return Effect.sync(() => {
      this.stopped = true;
    });
  }

  private process(entry: Assignment, observed = false): Effect.Effect<void, StorageError> {
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
          return yield* new DiscordRequestError({
            message: "Guild is unavailable",
            cause: new Error("Guild is unavailable"),
            retryable: true,
          });
        const member = yield* discordRequest(() =>
          guild.members.fetch({ user: entry.memberId, force: true }),
        );
        if (this.stopped) return;
        if (member.joinedTimestamp !== entry.joinedAt) {
          yield* this.store.remove(entry);
          return;
        }
        const latest = yield* this.store.get(entry.guildId, entry.memberId);
        if (!latest || latest.joinedAt !== entry.joinedAt) return;
        const result = yield* this.roles.assign(member, latest.screeningComplete === 1);
        if (result === "complete") yield* this.store.remove(entry);
        else
          yield* this.defer(
            entry,
            result === "pending" ? SCREENING_RECHECK_MS : CONFIGURATION_RECHECK_MS,
          );
      });
      const runAttempt = attempt.pipe(
        Effect.catchTag("ConfigurationError", (error) =>
          this.retry(entry, error, CONFIGURATION_RECHECK_MS),
        ),
        Effect.catchTag("DiscordRequestError", (error) => {
          if (this.stopped) return Effect.void;
          if (error.code === 10007) return this.store.remove(entry);
          // Permission failures can recover after an administrator changes settings.
          return this.retry(entry, error, error.retryable ? undefined : CONFIGURATION_RECHECK_MS);
        }),
      );
      let recheck = false;
      yield* runAttempt.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.active.delete(key);
            recheck = this.changed.delete(key);
          }),
        ),
      );
      // Further Discord work stays interruptible; finalizers only release state.
      if (recheck && !this.stopped) {
        const latest = yield* this.store.get(entry.guildId, entry.memberId);
        if (latest) yield* this.process(latest);
      }
    });
  }

  private retry(
    entry: Assignment,
    error: ConfigurationError | DiscordRequestError,
    delay?: number,
  ) {
    if (this.stopped) return Effect.void;
    return this.report(error, entry.guildId, entry.memberId).pipe(
      Effect.andThen(this.defer(entry, delay)),
    );
  }

  private defer(
    entry: Assignment,
    delay = Math.min(HOUR_MS, MINUTE_MS * 2 ** Math.min(entry.attempts, 6)),
  ) {
    return DateTime.now.pipe(
      Effect.flatMap((now) => this.store.defer(entry, DateTime.toEpochMillis(now) + delay)),
    );
  }
}
