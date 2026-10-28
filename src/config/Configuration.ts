import { Effect } from "effect";
import { ConfigurationError } from "../errors";

export type Configuration = Readonly<{
  token: string;
  applicationId: string;
  guildId: string | undefined;
}>;

export function readConfiguration(
  env = process.env,
): Effect.Effect<Configuration, ConfigurationError> {
  const token = env.DISCORD_TOKEN?.trim();
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const guildId = env.DISCORD_GUILD_ID?.trim() || undefined;
  if (!token) return Effect.fail(new ConfigurationError({ message: "Set DISCORD_TOKEN in .env" }));
  if (!applicationId || !/^\d{17,20}$/.test(applicationId)) {
    return Effect.fail(new ConfigurationError({ message: "Set a valid DISCORD_APPLICATION_ID" }));
  }
  if (guildId && !/^\d{17,20}$/.test(guildId)) {
    return Effect.fail(new ConfigurationError({ message: "Invalid DISCORD_GUILD_ID" }));
  }
  return Effect.succeed(Object.freeze({ token, applicationId, guildId }));
}
