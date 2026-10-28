import { expect, test } from "bun:test";
import { DiscordAPIError, HTTPError } from "discord.js";
import { Effect, Result } from "effect";
import { readConfiguration } from "../src/config/Configuration";
import { ConfigurationError, DiscordRequestError, discordRequest } from "../src/errors";

const unavailable = new HTTPError(503, "Unavailable", "GET", "https://discord.com", {});
const missingMember = new DiscordAPIError(
  { message: "Unknown Member", code: 10007 },
  10007,
  404,
  "GET",
  "https://discord.com",
  {},
);
const forbidden = new DiscordAPIError(
  { message: "Missing Permissions", code: 50013 },
  50013,
  403,
  "GET",
  "https://discord.com",
  {},
);
const reset = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });

for (const [cause, retryable] of [
  [unavailable, true],
  [missingMember, false],
  [forbidden, false],
  [new Error("fetch failed", { cause: reset }), true],
] as const) {
  test(`Discord error classification: ${cause.message}`, async () => {
    const result = await Effect.runPromise(
      Effect.result(discordRequest(() => Promise.reject(cause))),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(DiscordRequestError);
      expect(result.failure.cause).toBe(cause);
      expect(result.failure.retryable).toBe(retryable);
      expect(result.failure.code).toBe(cause instanceof DiscordAPIError ? cause.code : undefined);
    }
  });
}

test("cyclic error causes do not break classification", async () => {
  const first = new Error("first");
  const second = new Error("second", { cause: first });
  first.cause = second;
  const result = await Effect.runPromise(
    Effect.result(discordRequest(() => Promise.reject(first))),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure.retryable).toBe(false);
});

test("configuration failures have a separate tagged error channel", async () => {
  const result = await Effect.runPromise(Effect.result(readConfiguration({})));
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ConfigurationError);
});
