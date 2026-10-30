import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { JobWorker, type JobOutcome } from "../packages/jobs/worker";
import { AssignmentStore, assignmentKey, type Assignment } from "../src/bot/AssignmentStore";

const join = { guildId: "guild", memberId: "member", joinedAt: 123, screeningComplete: 0 };

for (const outcome of [
  { type: "complete" },
  { type: "retry", delay: 5000 },
] satisfies JobOutcome[]) {
  test(`a stale ${outcome.type} outcome cannot change a newer job`, async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(":memory:");
          yield* store.recordJoin(join);
          const first = yield* store.get(join.guildId, join.memberId);
          if (!first) throw new Error("Missing first assignment");
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const seen: number[] = [];
          const worker = new JobWorker({
            key: (entry: Assignment) => assignmentKey(entry.guildId, entry.memberId),
            due: (now) => store.due(now),
            reload: (entry) => store.get(entry.guildId, entry.memberId),
            complete: (entry) => store.remove(entry),
            defer: (entry, nextAttempt) => store.defer(entry, nextAttempt),
            attempt: (entry) =>
              Effect.gen(function* () {
                seen.push(entry.joinedAt);
                if (entry.joinedAt !== first.joinedAt) return { type: "skip" } as const;
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
                return outcome;
              }),
          });
          const running = yield* Effect.forkChild(worker.run(first));
          yield* Deferred.await(started);
          yield* store.recordJoin({ ...join, joinedAt: 456 });
          const replacement = yield* store.get(join.guildId, join.memberId);
          if (!replacement) throw new Error("Missing replacement assignment");
          yield* worker.run(replacement, true);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(running);
          expect(seen).toEqual([123, 456]);
          expect(yield* store.get(join.guildId, join.memberId)).toEqual({
            ...join,
            joinedAt: 456,
            attempts: 0,
            nextAttempt: 0,
          });
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
}

test("interrupting an attempt leaves its assignment outstanding", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AssignmentStore.make(":memory:");
        yield* store.recordJoin(join);
        const entry = yield* store.get(join.guildId, join.memberId);
        if (!entry) throw new Error("Missing assignment");
        const started = yield* Deferred.make<void>();
        const worker = new JobWorker({
          key: (job: Assignment) => assignmentKey(job.guildId, job.memberId),
          due: (now) => store.due(now),
          reload: (job) => store.get(job.guildId, job.memberId),
          complete: (job) => store.remove(job),
          defer: (job, nextAttempt) => store.defer(job, nextAttempt),
          attempt: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const running = yield* Effect.forkChild(worker.run(entry));
        yield* Deferred.await(started);
        yield* Fiber.interrupt(running);
        expect(yield* store.get(join.guildId, join.memberId)).toEqual({
          ...join,
          attempts: 0,
          nextAttempt: 0,
        });
      }),
    ),
  );
});
