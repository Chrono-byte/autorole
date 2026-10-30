import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { StorageError } from "../src/errors";
import { AssignmentStore } from "../src/bot/AssignmentStore";

const observed = { guildId: "guild", memberId: "member", joinedAt: 123, screeningComplete: 0 };

test("storage preserves records across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autorole-store-"));
  const path = join(directory, "assignments.sqlite");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(path);
          yield* store.recordJoin(observed);
          const record = yield* store.get("guild", "member");
          expect(record?.screeningComplete).toBe(0);
          if (!record) throw new Error("Recorded join missing");
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

test("legacy assignment tables stop startup without changing stored records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autorole-legacy-"));
  const path = join(directory, "assignments.sqlite");
  const db = new Database(path, { create: true });
  db.run(
    "CREATE TABLE assignments (guildId TEXT NOT NULL, memberId TEXT NOT NULL, joinedAt INTEGER NOT NULL, attempts INTEGER NOT NULL, nextAttempt INTEGER NOT NULL, screeningComplete INTEGER NOT NULL, PRIMARY KEY (guildId, memberId))",
  );
  db.run("INSERT INTO assignments VALUES ('guild', 'member', 123, 4, 5000, 1)");
  db.close();
  try {
    const result = await Effect.runPromise(
      Effect.result(Effect.scoped(AssignmentStore.make(path))),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure.message).toContain("Legacy assignments table found");
    const reopened = new Database(path);
    try {
      expect(reopened.query("SELECT * FROM assignments").get()).toEqual({
        ...observed,
        attempts: 4,
        nextAttempt: 5000,
        screeningComplete: 1,
      });
      expect(
        reopened
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
          .get(),
      ).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an empty legacy table permits startup and remains available for rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autorole-empty-legacy-"));
  const path = join(directory, "assignments.sqlite");
  const db = new Database(path, { create: true });
  db.run("CREATE TABLE assignments (guildId TEXT, memberId TEXT)");
  db.close();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(path);
          yield* store.recordJoin(observed);
          expect(yield* store.get("guild", "member")).toMatchObject(observed);
        }),
      ),
    );
    const reopened = new Database(path);
    try {
      expect(reopened.query("SELECT count(*) AS count FROM assignments").get()).toEqual({
        count: 0,
      });
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid persisted jobs report the operation without hiding the cause", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autorole-invalid-job-"));
  const path = join(directory, "assignments.sqlite");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(path);
          yield* store.recordJoin(observed);
        }),
      ),
    );
    const db = new Database(path);
    db.run("UPDATE jobs SET payload = '{invalid'");
    db.close();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AssignmentStore.make(path);
          for (const [operation, effect] of [
            ["get", store.get("guild", "member").pipe(Effect.asVoid)],
            ["due", store.due(0).pipe(Effect.asVoid)],
          ] as const) {
            const result = yield* Effect.result(effect);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure.operation).toBe(operation);
              expect(result.failure.cause).toBeInstanceOf(Error);
            }
          }
        }),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
