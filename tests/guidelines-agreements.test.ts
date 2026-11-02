import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { AgreementStore } from "../src/bot/guidelines/AgreementStore";

test("agreement dates persist and repeat clicks preserve the original date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guidelines-"));
  const path = join(dir, "state.sqlite");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AgreementStore.make(path);
          yield* store.record("guild", "member", "message", 1234);
          yield* store.record("guild", "member", "message", 5678);
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AgreementStore.make(path);
          expect(yield* store.get("guild", "member", "message")).toEqual({
            guildId: "guild",
            memberId: "member",
            messageId: "message",
            agreedAt: 1234,
          });
          expect(yield* store.get("guild", "other", "message")).toBeNull();
        }),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
