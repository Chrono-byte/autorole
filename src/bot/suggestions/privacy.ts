import { PermissionFlagsBits } from "discord.js";

const guildId = "1415400507006124093";
const permitted = new Set([
  guildId,
  "1564387083642998897",
  "1550224203972870194",
  "1565937863802228818",
  "1415400507006124101",
]);

/** Fail closed if an overwrite grants inbox visibility beyond its intended roles. */
export function privateSuggestionOverwrites(
  overwrites: readonly { id: string; type: number; allow: bigint; deny: bigint }[],
) {
  const everyone = overwrites.find((overwrite) => overwrite.id === guildId && overwrite.type === 0);
  if (
    !everyone ||
    !(everyone.deny & PermissionFlagsBits.ViewChannel) ||
    everyone.allow & PermissionFlagsBits.ViewChannel
  )
    return false;
  return overwrites.every(
    (overwrite) =>
      !(overwrite.allow & PermissionFlagsBits.ViewChannel) ||
      (overwrite.type === 0 && permitted.has(overwrite.id)),
  );
}
