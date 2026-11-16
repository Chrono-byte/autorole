import { describe, expect, test } from "bun:test";
import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
  type Client,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Effect, Result } from "effect";
import { refreshServerStats } from "../src/bot/ServerStats";
import { serverStatsCommands } from "../src/bot/commands/ServerStatsCommand";
import { StatsStore } from "../src/bot/StatsStore";

test("setting the counter channel immediately updates its name before confirming", async () => {
  const actions: string[] = [];
  const channel = {
    id: "counter",
    type: ChannelType.GuildVoice,
    name: "Old name",
    setName: async (name: string) => actions.push(name),
  };
  const interaction = {
    commandName: "member-counter",
    guildId: "guild",
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: { getChannel: () => channel },
    client: {
      guilds: {
        fetch: async () => ({
          members: {
            fetch: async () =>
              new Collection([
                ["human", { user: { bot: false } }],
                ["bot", { user: { bot: true } }],
              ]),
          },
          channels: { fetch: async () => channel },
        }),
      },
    },
    deferReply: async () => actions.push("deferred"),
    editReply: async (content: string) => actions.push(content),
  } as unknown as ChatInputCommandInteraction;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* StatsStore.make(":memory:");
        yield* serverStatsCommands(store).dispatch(interaction);
        expect(yield* store.list()).toEqual([{ guildId: "guild", channelId: "counter" }]);
      }),
    ),
  );
  expect(actions).toEqual([
    "deferred",
    "Members: 1",
    "Member counter set to <#counter> and updated.",
  ]);
});

describe("server counters", () => {
  test("excludes bots and updates the member channel", async () => {
    const updates: string[] = [];
    const members = new Collection([
      ["1", { user: { bot: false } }],
      ["2", { user: { bot: false } }],
      ["3", { user: { bot: true } }],
    ]);
    const channels = new Map([
      ["people", { name: "Members: 1", setName: async (name: string) => updates.push(name) }],
      ["bots", { name: "Bots: 1", setName: async (name: string) => updates.push(name) }],
    ]);
    const guild = {
      members: { fetch: async () => members },
      channels: { fetch: async (id: string) => channels.get(id) },
    };
    const client = { guilds: { fetch: async () => guild } } as unknown as Client;
    await Effect.runPromise(refreshServerStats(client, "guild", "people"));
    expect(updates).toEqual(["Members: 2"]);
  });
});

test("counter settings persist across restarts without a bootstrap", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "sigil-stats-"));
  const path = join(dir, "stats.sqlite");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* StatsStore.make(path);
          expect(yield* store.list()).toEqual([]);
          yield* store.set("1415400507006124093", "replacement");
          yield* store.set("another-server", "another-channel");
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* StatsStore.make(path);
          expect(yield* store.list()).toEqual([
            { guildId: "1415400507006124093", channelId: "replacement" },
            { guildId: "another-server", channelId: "another-channel" },
          ]);
        }),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counter command requires Manage Server at execution time", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* StatsStore.make(":memory:");
        const registry = serverStatsCommands(store);
        const interaction = {
          commandName: "member-counter",
          guildId: "1415400507006124093",
          memberPermissions: new PermissionsBitField(0n),
          options: {
            getChannel: () => {
              throw new Error("Must not access options");
            },
          },
        } as unknown as import("discord.js").ChatInputCommandInteraction;
        const result = yield* Effect.result(registry.dispatch(interaction));
        expect(Result.isFailure(result)).toBe(true);
        expect(yield* store.list()).toEqual([]);
        expect(serverStatsCommands(store).definitions[0]?.toJSON()).toMatchObject({
          default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
        });
      }),
    ),
  );
});
