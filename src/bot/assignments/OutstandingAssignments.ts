import { type Client, type GuildMember, type PartialGuildMember } from "discord.js";
import { Effect } from "effect";
import { JobWorker, type JobOutcome } from "../../../packages/jobs/worker";
import {
  ConfigurationError,
  DiscordRequestError,
  StorageError,
  discordRequest,
} from "../../errors";
import { logError } from "../../logger";
import { AssignmentStore, assignmentKey, type Assignment } from "./AssignmentStore";
import { RoleService } from "../RoleService";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const RECHECK_MS = 5 * MINUTE_MS;

function retryDelay(
  entry: Assignment,
  reason: "pending" | "disabled" | ConfigurationError | DiscordRequestError,
) {
  if (reason instanceof DiscordRequestError && reason.retryable)
    return Math.min(HOUR_MS, MINUTE_MS * 2 ** Math.min(entry.attempts, 6));
  return RECHECK_MS;
}

export class OutstandingAssignments {
  private readonly worker = new JobWorker<Assignment, StorageError>({
    key: (entry) => assignmentKey(entry.guildId, entry.memberId),
    due: (now) => this.store.due(now),
    reload: (entry) => this.store.get(entry.guildId, entry.memberId),
    complete: (entry) => this.store.remove(entry),
    defer: (entry, nextAttempt) => this.store.defer(entry, nextAttempt),
    attempt: (entry) =>
      this.attempt(entry).pipe(
        Effect.catchTag(["ConfigurationError", "DiscordRequestError"], (error) => {
          if (
            !this.worker.isStopped &&
            error instanceof DiscordRequestError &&
            error.code === 10007
          )
            return Effect.succeed({ type: "complete" as const });
          return this.retry(entry, error);
        }),
      ),
  });

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
    return this.worker.start(MINUTE_MS, (error) =>
      logError("autorole_reconcile_failed", { operation: error.operation, message: error.message }),
    );
  }

  observeJoin = Effect.fn("OutstandingAssignments.observeJoin")(function* (
    this: OutstandingAssignments,
    member: GuildMember,
  ) {
    if (
      this.worker.isStopped ||
      member.user.bot ||
      (this.guildId && this.guildId !== member.guild.id)
    )
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
    if (this.worker.isStopped) return;
    const entry = yield* this.store.get(member.guild.id, member.id);
    if (!entry) return;
    if (member.pending === false && member.joinedTimestamp === entry.joinedAt)
      yield* this.store.completeScreening(entry);
    yield* this.worker.run(entry, true);
  });

  reconcile() {
    return this.worker.reconcile();
  }

  stop() {
    return this.worker.stop();
  }

  private attempt = Effect.fn("OutstandingAssignments.attempt")(function* (
    this: OutstandingAssignments,
    entry: Assignment,
  ) {
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
    if (this.worker.isStopped) return { type: "skip" } as const;
    if (member.joinedTimestamp !== entry.joinedAt) return { type: "complete" } as const;
    const latest = yield* this.store.get(entry.guildId, entry.memberId);
    if (!latest || latest.joinedAt !== entry.joinedAt) return { type: "skip" } as const;
    const result = yield* this.roles.assign(member, latest.screeningComplete === 1);
    if (result === "complete") return { type: "complete" } as const;
    return { type: "retry", delay: retryDelay(entry, result) } as const;
  });

  private retry(
    entry: Assignment,
    error: ConfigurationError | DiscordRequestError,
  ): Effect.Effect<JobOutcome> {
    if (this.worker.isStopped) return Effect.succeed({ type: "skip" as const });
    return this.report(error, entry.guildId, entry.memberId).pipe(
      Effect.as({ type: "retry" as const, delay: retryDelay(entry, error) }),
    );
  }
}
