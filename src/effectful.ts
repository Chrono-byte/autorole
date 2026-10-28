import { Effect } from "effect";

export function asError(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause));
}

export function tryPromise<A>(run: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({ try: run, catch: asError });
}

export function trySync<A>(run: () => A) {
  return Effect.try({ try: run, catch: asError });
}
