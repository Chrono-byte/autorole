export function readConfiguration(env = process.env) {
  const token = env.DISCORD_TOKEN?.trim();
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const guildId = env.DISCORD_GUILD_ID?.trim() || undefined;
  if (!token) throw new Error("Set DISCORD_TOKEN in .env");
  if (!applicationId || !/^\d{17,20}$/.test(applicationId))
    throw new Error("Set a valid DISCORD_APPLICATION_ID");
  if (guildId && !/^\d{17,20}$/.test(guildId)) throw new Error("Invalid DISCORD_GUILD_ID");
  return Object.freeze({ token, applicationId, guildId });
}

export type Configuration = ReturnType<typeof readConfiguration>;
