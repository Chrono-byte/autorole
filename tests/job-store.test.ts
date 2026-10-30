import { expect, test } from "bun:test";
import { Effect, Result } from "effect";
import { JobStore } from "@autorole/jobs";

test("patch accepts a single field and rejects unsafe JSON paths", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* JobStore.make(":memory:");
        const identity = { key: "key", generation: 1 };
        yield* store.put({ ...identity, payload: '{"safe_field":0,"nested":{"value":0}}' });
        yield* store.patch(identity, "safe_field", 1);
        for (const field of ["", "nested.value", 'a"b', "a[0]", "a]", "a\n", "a\u007f"]) {
          const result = yield* Effect.result(store.patch(identity, field, 2));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.operation).toBe("patch");
            expect(result.failure.cause).toBeInstanceOf(RangeError);
          }
        }
        expect(JSON.parse((yield* store.get("key"))!.payload)).toEqual({
          safe_field: 1,
          nested: { value: 0 },
        });
      }),
    ),
  );
});
