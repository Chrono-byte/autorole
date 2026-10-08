import { expect, test } from "bun:test";
import { readConfiguration } from "../src/config/Configuration";
test("configuration rejects missing token and invalid application ID", () => {
  expect(() => readConfiguration({})).toThrow("DISCORD_TOKEN");
  expect(() => readConfiguration({ DISCORD_TOKEN: "test", DISCORD_APPLICATION_ID: "bad" })).toThrow(
    "DISCORD_APPLICATION_ID",
  );
});

test("configuration trims values and preserves guild scope", () => {
  expect(
    readConfiguration({
      DISCORD_TOKEN: " fixture ",
      DISCORD_APPLICATION_ID: " 100000000000000001 ",
      DISCORD_GUILD_ID: " 100000000000000002 ",
    }),
  ).toEqual({
    token: "fixture",
    applicationId: "100000000000000001",
    guildId: "100000000000000002",
  });
});

test("missing and blank guild IDs select global scope; invalid IDs fail", () => {
  const env = { DISCORD_TOKEN: "fixture", DISCORD_APPLICATION_ID: "100000000000000001" };
  expect(readConfiguration(env).guildId).toBeUndefined();
  expect(readConfiguration({ ...env, DISCORD_GUILD_ID: "   " }).guildId).toBeUndefined();
  expect(() => readConfiguration({ ...env, DISCORD_GUILD_ID: "bad" })).toThrow(
    "Invalid DISCORD_GUILD_ID",
  );
});
