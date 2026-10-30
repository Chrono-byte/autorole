import { Schema } from "effect";

export { DiscordRequestError, discordRequest } from "@autorole/discord-framework";

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  { message: Schema.String },
) {}

export class StorageError extends Schema.TaggedError<StorageError>()("StorageError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
