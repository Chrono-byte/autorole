import { REST, Routes, PermissionsBitField, type APIChannel, type APIRole } from "discord.js";

const guildId = process.argv[2] ?? process.env.DISCORD_GUILD_ID;
const token = process.env.DISCORD_TOKEN;

if (!token || !guildId || !/^\d{17,20}$/.test(guildId)) {
  console.error("Usage: bun run audit:grants <guild-id> (requires DISCORD_TOKEN)");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);
const [channels, roles] = (await Promise.all([
  rest.get(Routes.guildChannels(guildId)),
  rest.get(Routes.guildRoles(guildId)),
])) as [APIChannel[], APIRole[]];
const everyone = roles.find((role) => role.id === guildId);
if (!everyone) throw new Error("Discord did not return the @everyone role.");
const defaults = BigInt(everyone.permissions);
const roleNames = new Map(roles.map((role) => [role.id, role.name]));
let findings = 0;

for (const channel of channels) {
  if (!("permission_overwrites" in channel) || !channel.permission_overwrites) continue;
  const overwrites = channel.permission_overwrites;
  const all = overwrites.find((entry) => entry.type === 0 && entry.id === guildId);
  const base = (defaults & ~BigInt(all?.deny ?? 0)) | BigInt(all?.allow ?? 0);
  const category =
    "parent_id" in channel ? channels.find((item) => item.id === channel.parent_id) : undefined;

  for (const entry of overwrites) {
    if (entry.type !== 0) continue;
    let redundant = 0n;
    if (entry.id === guildId) {
      redundant = BigInt(entry.allow) & defaults;
    } else {
      const otherDenials = overwrites
        .filter((other) => other.type === 0 && other.id !== guildId && other.id !== entry.id)
        .reduce((bits, other) => bits | BigInt(other.deny), 0n);
      redundant = BigInt(entry.allow) & base & ~otherDenials;
    }
    if (redundant === 0n) continue;
    findings++;
    console.log(
      JSON.stringify({
        channel: channel.name,
        channelId: channel.id,
        category: category && "name" in category ? category.name : null,
        role: roleNames.get(entry.id) ?? entry.id,
        roleId: entry.id,
        redundantAllows: new PermissionsBitField(redundant).toArray(),
      }),
    );
  }
}

console.error(`Found ${findings} role overwrites with redundant allows. No changes made.`);
