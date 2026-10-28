import { DiscordAPIError, HTTPError } from "discord.js";
import { Effect, Schema } from "effect";
import { asError } from "./effectful";

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  { message: Schema.String },
) {}

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export class DiscordRequestError extends Schema.TaggedError<DiscordRequestError>()(
  "DiscordRequestError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
    code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    retryable: Schema.Boolean,
  },
) {}

const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isTransient(error: Error): boolean {
  const seen = new Set<Error>();
  let current: Error | undefined = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof DiscordAPIError || current instanceof HTTPError)
      return current.status === 429 || (current.status >= 500 && current.status < 600);
    if (current.name === "TimeoutError") return true;
    if ("code" in current && typeof current.code === "string" && networkCodes.has(current.code))
      return true;
    current = current.cause instanceof Error ? current.cause : undefined;
  }
  return false;
}

export function discordRequest<A>(run: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new DiscordRequestError({
        message: asError(cause).message,
        cause,
        code: cause instanceof DiscordAPIError ? cause.code : undefined,
        retryable: isTransient(asError(cause)),
      }),
  });
}
