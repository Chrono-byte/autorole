import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { StorageError } from "../src/errors";
import { AssignmentStore } from "../src/storage/AssignmentStore";

const observed = { guildId: "guild", memberId: "member", joinedAt: 123, screeningComplete: 0 };

test("storage preserves records across reopen and migrates the previous schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autorole-store-"));
  const path = join(directory, "assignments.sqlite");
  const old = new Database(path, { create: true });
  old.run(
    "CREATE TABLE assignments (guildId TEXT NOT NULL, memberId TEXT NOT NULL, joinedAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAttempt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guildId, memberId))",
  );
  old.run("INSERT INTO assignments (guildId, memberId, joinedAt) VALUES ('guild', 'member', 123)");
  old.close();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(path);
          const record = yield* store.get("guild", "member");
          expect(record?.screeningComplete).toBe(0);
          if (!record) throw new Error("Record missing after migration");
          yield* store.completeScreening(record);
          yield* store.defer(record, 5000);
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(path);
          const record = yield* store.get("guild", "member");
          expect(record).toMatchObject({
            ...observed,
            attempts: 1,
            nextAttempt: 5000,
            screeningComplete: 1,
          });
          expect(yield* store.due(4999)).toEqual([]);
          expect(yield* store.due(5000)).toHaveLength(1);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale work cannot change or remove a newer join", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AssignmentStore.make(":memory:");
        yield* store.recordJoin(observed);
        const previous = yield* store.get("guild", "member");
        if (!previous) throw new Error("Expected recorded join");
        yield* store.recordJoin({ ...observed, joinedAt: 456 });
        yield* store.completeScreening(previous);
        yield* store.defer(previous, 999);
        yield* store.remove(previous);
        expect(yield* store.get("guild", "member")).toEqual({
          ...observed,
          joinedAt: 456,
          attempts: 0,
          nextAttempt: 0,
        });
      }),
    ),
  );
});

test("storage closes with its scope and exposes tagged failures", async () => {
  const store = await Effect.runPromise(Effect.scoped(AssignmentStore.make(":memory:")));
  const result = await Effect.runPromise(Effect.result(store.get("guild", "member")));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure).toBeInstanceOf(StorageError);
    expect(result.failure.operation).toBe("get");
  }
});

test("storage open failure is tagged without losing the underlying cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autorole-store-fail-"));
  const file = join(directory, "file");
  await writeFile(file, "not a directory");
  try {
    const result = await Effect.runPromise(
      Effect.result(Effect.scoped(AssignmentStore.make(join(file, "database")))),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(StorageError);
      expect(result.failure.operation).toBe("open");
      expect(result.failure.cause).toBeInstanceOf(Error);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration preserves existing screening evidence and retry state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autorole-migrate-"));
  const path = join(directory, "assignments.sqlite");
  const db = new Database(path, { create: true });
  db.run(
    "CREATE TABLE assignments (guildId TEXT NOT NULL, memberId TEXT NOT NULL, joinedAt INTEGER NOT NULL, attempts INTEGER NOT NULL, nextAttempt INTEGER NOT NULL, screeningComplete INTEGER NOT NULL, PRIMARY KEY (guildId, memberId))",
  );
  db.run("INSERT INTO assignments VALUES ('guild', 'member', 123, 4, 5000, 1)");
  db.close();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(path);
          expect(yield* store.get("guild", "member")).toEqual({
            ...observed,
            screeningComplete: 1,
            attempts: 4,
            nextAttempt: 5000,
          });
          expect(yield* store.due(4999)).toEqual([]);
          expect(yield* store.due(5000)).toHaveLength(1);
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(path);
          expect((yield* store.get("guild", "member"))?.attempts).toBe(4);
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
