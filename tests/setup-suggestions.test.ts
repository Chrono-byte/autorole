import { expect, test } from "bun:test";
import {
  ApplicationFlagsBitField,
  ChannelType,
  PermissionFlagsBits as F,
  Routes,
  type REST,
} from "discord.js";
import { Effect } from "effect";
import { setupSuggestions } from "../src/cli/setup-suggestions";
import {
  suggestionGuildId,
  suggestionInboxChannelId,
  suggestionOpenId,
  suggestionPanelChannelId,
} from "../src/bot/suggestions/Suggestions";

const appId = "1551628047323762811",
  category = "1566109875535355994",
  staff = "1557133002285387857";
function fixture() {
  const privateOverwrites = [
    { id: suggestionGuildId, type: 0, allow: "0", deny: F.ViewChannel.toString() },
    {
      id: "1564387083642998897",
      type: 0,
      allow: (F.ViewChannel | F.SendMessagesInThreads).toString(),
      deny: "0",
    },
  ];
  const inbox = {
    id: suggestionInboxChannelId,
    guild_id: suggestionGuildId,
    type: ChannelType.GuildText,
    parent_id: category,
    permission_overwrites: privateOverwrites,
  };
  const parent = {
    id: category,
    guild_id: suggestionGuildId,
    type: ChannelType.GuildCategory,
    parent_id: null,
    permission_overwrites: [...privateOverwrites],
  };
  const panel = {
    id: suggestionPanelChannelId,
    guild_id: suggestionGuildId,
    type: ChannelType.GuildText,
    parent_id: "100000000000000001",
    permission_overwrites: [{ id: staff, type: 0, allow: "0", deny: "0" }],
  };
  const messages: unknown[] = [];
  const writes: { method: string; route: string; body: unknown }[] = [];
  const rest = {
    get: async (route: string) => {
      if (route === Routes.oauth2CurrentApplication())
        return {
          id: appId,
          flags: Number(ApplicationFlagsBitField.Flags.GatewayMessageContentLimited),
        };
      if (route === Routes.channel(suggestionInboxChannelId)) return inbox;
      if (route === Routes.channel(category)) return parent;
      if (route === Routes.channel(suggestionPanelChannelId)) return panel;
      if (route === Routes.guildRoles(suggestionGuildId))
        return [
          { id: suggestionGuildId, permissions: "0" },
          { id: "1564387083642998897", permissions: "0" },
        ];
      if (route === Routes.channelMessages(suggestionPanelChannelId)) return messages;
      throw new Error(`Unexpected GET ${route}`);
    },
    post: async (route: string, options: { body: unknown }) => {
      writes.push({ method: "post", route, body: options.body });
      messages.push({
        id: "100000000000000002",
        author: { id: appId },
        components: [{ components: [{ custom_id: suggestionOpenId }] }],
      });
    },
    patch: async (route: string, options: { body: unknown }) => {
      writes.push({ method: "patch", route, body: options.body });
    },
    put: async (
      route: string,
      options: { body: { type: number; allow: string; deny: string } },
    ) => {
      writes.push({ method: "put", route, body: options.body });
      const i = panel.permission_overwrites.findIndex((o) => o.id === suggestionGuildId);
      const item = { id: suggestionGuildId, ...options.body };
      if (i === -1) panel.permission_overwrites.push(item);
      else panel.permission_overwrites[i] = item;
    },
  } as unknown as REST;
  return { rest, inbox, panel, writes, messages };
}
const config = { token: "fixture", applicationId: appId, guildId: undefined };

test("suggestion setup posts once, denies public posting, and updates the panel on rerun", async () => {
  const f = fixture();
  await Effect.runPromise(setupSuggestions(config, f.rest));
  const blocked =
    F.SendMessages | F.CreatePublicThreads | F.CreatePrivateThreads | F.SendMessagesInThreads;
  const everyone = f.panel.permission_overwrites.find((o) => o.id === suggestionGuildId);
  expect(everyone && BigInt(everyone.deny) & blocked).toBe(blocked);
  expect(f.writes.filter((w) => w.method === "post")).toHaveLength(1);
  await Effect.runPromise(setupSuggestions(config, f.rest));
  expect(f.writes.filter((w) => w.method === "post")).toHaveLength(1);
  expect(f.writes.filter((w) => w.method === "patch")).toHaveLength(1);
});

test("suggestion setup refuses to publish a panel when the inbox is visible to another role", async () => {
  const f = fixture();
  f.inbox.permission_overwrites.push({
    id: "100000000000000003",
    type: 0,
    allow: F.ViewChannel.toString(),
    deny: "0",
  });
  await expect(Effect.runPromise(setupSuggestions(config, f.rest))).rejects.toThrow(
    "not configured safely",
  );
  expect(f.writes).toEqual([]);
});

test("suggestion preflight is read-only", async () => {
  const f = fixture();
  await Effect.runPromise(setupSuggestions(config, f.rest, { checkOnly: true }));
  expect(f.writes).toEqual([]);
});
