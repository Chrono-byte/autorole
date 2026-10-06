import { expect, test } from "bun:test";
import { Configuration } from "../src/Configuration";
test("configuration rejects missing token and invalid application ID", () => {
  expect(() => new Configuration({})).toThrow("DISCORD_TOKEN");
  expect(() => new Configuration({ DISCORD_TOKEN: "test", DISCORD_APPLICATION_ID: "bad" })).toThrow(
    "DISCORD_APPLICATION_ID",
  );
});
