import { expect, spyOn, test } from "bun:test";
import { REST, Routes } from "discord.js";
import { CommandCleaner } from "../src/cli/clean-commands";
import { Configuration } from "../src/config/Configuration";

const applicationId = "100000000000000001";
const guildId = "100000000000000002";
const staleId = "100000000000000003";
const commands = [
  { id: "100000000000000004", name: "autorole", type: 1 },
  { id: "100000000000000005", name: "autorole-target", type: 1 },
  { id: staleId, name: "old-command", type: 1 },
  { id: "100000000000000006", name: "User action", type: 2 },
  { id: "100000000000000007", name: "Message action", type: 3 },
];

for (const scope of ["guild", "global"]) {
  test(`cleanup removes only obsolete slash commands in ${scope} scope`, async () => {
    const config = new Configuration({
      DISCORD_TOKEN: "fixture",
      DISCORD_APPLICATION_ID: applicationId,
      DISCORD_GUILD_ID: guildId,
    });
    const rest = new REST();
    const get = spyOn(rest, "get").mockResolvedValue(commands);
    const remove = spyOn(rest, "delete").mockResolvedValue(undefined);
    try {
      await new CommandCleaner(config, rest).clean(scope === "guild" ? "guild" : "global");
      expect(get).toHaveBeenCalledWith(
        scope === "guild"
          ? Routes.applicationGuildCommands(applicationId, guildId)
          : Routes.applicationCommands(applicationId),
      );
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith(
        scope === "guild"
          ? Routes.applicationGuildCommand(applicationId, guildId, staleId)
          : Routes.applicationCommand(applicationId, staleId),
      );
    } finally {
      get.mockRestore();
      remove.mockRestore();
    }
  });
}

test("cleanup validates the whole list before deleting anything", async () => {
  const config = new Configuration({
    DISCORD_TOKEN: "fixture",
    DISCORD_APPLICATION_ID: applicationId,
  });
  const rest = new REST();
  const get = spyOn(rest, "get").mockResolvedValue([commands[2], { name: "broken" }]);
  const remove = spyOn(rest, "delete").mockResolvedValue(undefined);
  try {
    await expect(new CommandCleaner(config, rest).clean("global")).rejects.toThrow(
      "invalid command",
    );
    expect(remove).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    remove.mockRestore();
  }
});

test("guild cleanup without a guild ID fails before contacting Discord", async () => {
  const config = new Configuration({
    DISCORD_TOKEN: "fixture",
    DISCORD_APPLICATION_ID: applicationId,
  });
  const rest = new REST();
  const get = spyOn(rest, "get").mockResolvedValue(commands);
  try {
    await expect(new CommandCleaner(config, rest).clean("guild")).rejects.toThrow(
      "DISCORD_GUILD_ID",
    );
    expect(get).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
  }
});
