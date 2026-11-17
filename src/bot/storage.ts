import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import { asError } from "../effectful";
import { StorageError } from "../errors";

export const operation = <A>(name: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (cause) => new StorageError({ operation: name, message: asError(cause).message, cause }),
  });

export function openStore(path: string, name: string) {
  return Effect.acquireRelease(
    operation(name, () => {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const db = new Database(path, { create: true });
      try {
        if (path !== ":memory:") chmodSync(path, 0o600);
      } catch (error) {
        db.close();
        throw error;
      }
      return db;
    }),
    (db) => Effect.sync(() => db.close()),
  );
}
