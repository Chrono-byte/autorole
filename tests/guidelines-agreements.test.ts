import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { AgreementStore } from "../src/bot/guidelines/AgreementStore";

test("agreement dates persist and repeat clicks preserve the original date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guidelines-"));
  const path = join(dir, "state.sqlite");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AgreementStore.make(path);
          yield* store.record("guild", "member", "message", 1234);
          yield* store.record("guild", "member", "message", 5678);
        }),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AgreementStore.make(path);
          expect(yield* store.get("guild", "member", "message")).toEqual({
            guildId: "guild",
            memberId: "member",
            messageId: "message",
            agreedAt: 1234,
          });
          expect(yield* store.get("guild", "other", "message")).toBeNull();
        }),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renewal preserves prior agreements and rejects stale buttons", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const initial = {
          id: "first",
          guildId: "guild",
          channelId: "channel",
          messageId: "message",
          period: "Fall",
          version: "v1",
          startedAt: 10,
        };
        yield* store.startPeriod(initial);
        expect(
          yield* store.acceptCurrent("guild", "first", "channel", "message", "member", 20),
        ).toBe(true);
        expect(
          yield* store.acceptCurrent("guild", "first", "channel", "message", "member", 30),
        ).toBe(false);
        yield* store.startPeriod({ ...initial, id: "second", period: "Spring", startedAt: 40 });
        expect((yield* store.active("guild"))?.id).toBe("second");
        expect(
          yield* store.acceptCurrent("guild", "first", "channel", "message", "other", 50),
        ).toBe(false);
        expect(
          yield* store.acceptCurrent("guild", "second", "other-channel", "message", "member", 50),
        ).toBe(false);
        expect(yield* store.getAcceptance("second", "member")).toBeNull();
        expect(
          yield* store.acceptCurrent("guild", "second", "channel", "message", "member", 60),
        ).toBe(true);
        expect((yield* store.getAcceptance("first", "member"))?.agreedAt).toBe(20);
        expect((yield* store.getAcceptance("second", "member"))?.agreedAt).toBe(60);
      }),
    ),
  );
});

test("team role swaps preserve assignments and report bypassing overwrites", async () => {
  const { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } =
    await import("discord.js");
  const { reconcileTeamGate } = await import("../src/bot/guidelines/TeamGate");
  const { rosterGuildId } = await import("../src/bot/commands/syncRoster");
  const mapping = [
    { category: "category", identity: ["team", "pending"], team: "team", pending: "pending" },
  ];
  const assigned = new Set(["team", "captain"]);
  const member = {
    id: "member",
    permissions: new PermissionsBitField(0n),
    roles: {
      get cache() {
        return new Collection([...assigned].map((id) => [id, { id }]));
      },
      add: async (id: string) => {
        assigned.add(id);
      },
      remove: async (id: string) => {
        assigned.delete(id);
      },
    },
  };
  const roles = new Collection(
    ["team", "pending", "captain"].map((id) => [
      id,
      { id, managed: false, permissions: new PermissionsBitField(0n) },
    ]),
  );
  const overwrites = new Collection([
    [
      rosterGuildId,
      {
        id: rosterGuildId,
        type: 0,
        deny: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
        allow: new PermissionsBitField(0n),
      },
    ],
    [
      "team",
      {
        id: "team",
        type: 0,
        deny: new PermissionsBitField(0n),
        allow: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
      },
    ],
    [
      "captain",
      {
        id: "captain",
        type: 0,
        deny: new PermissionsBitField(0n),
        allow: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
      },
    ],
  ]);
  const category = {
    id: "category",
    type: ChannelType.GuildCategory,
    parentId: null,
    permissionOverwrites: { cache: overwrites },
    permissionsFor: () => new PermissionsBitField(0n),
  };
  const shared = {
    id: "1565003638852550768",
    type: ChannelType.GuildCategory,
    parentId: null,
    permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel),
  };
  const guild = {
    id: rosterGuildId,
    ownerId: "owner",
    roles: { fetch: async () => roles },
    channels: {
      fetch: async () =>
        new Collection([
          ["category", category],
          [shared.id, shared],
        ]),
    },
    members: {
      fetchMe: async () => ({
        permissions: new PermissionsBitField(8n),
        roles: { highest: { comparePositionTo: () => 1 } },
      }),
      list: async () => new Collection([["member", member]]),
      fetch: async () => member,
    },
  } as unknown as import("discord.js").Guild;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        yield* store.startPeriod({
          id: "period",
          guildId: rosterGuildId,
          channelId: "channel",
          messageId: "message",
          period: "Fall",
          version: "1",
          startedAt: 1,
        });
        expect(yield* reconcileTeamGate(guild, store, mapping)).toEqual({
          changed: 1,
          failed: [],
          conflicts: ["member"],
        });
        expect([...assigned].toSorted()).toEqual(["captain", "pending"]);
        yield* store.acceptCurrent(rosterGuildId, "period", "channel", "message", "member", 2);
        expect(yield* reconcileTeamGate(guild, store, mapping)).toEqual({
          changed: 1,
          failed: [],
          conflicts: [],
        });
        expect([...assigned].toSorted()).toEqual(["captain", "team"]);
      }),
    ),
  );
});

test("renewal run in general fetches the agreement message in team-guidelines", async () => {
  const { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } =
    await import("discord.js");
  const { guidelinesCommands } = await import("../src/bot/guidelines/GuidelinesCommand");
  const { teamRolesFromEnv } = await import("../src/bot/guidelines/TeamGate");
  const { rosterGuildId } = await import("../src/bot/commands/syncRoster");
  const mapping = teamRolesFromEnv({});
  if (!mapping) throw new Error("Missing configured team roles");
  const allRoles = new Collection(
    mapping
      .flatMap(({ team, pending }) => [team, pending])
      .map((id) => [id, { id, managed: false, permissions: new PermissionsBitField(0n) }]),
  );
  const view = new PermissionsBitField(PermissionFlagsBits.ViewChannel),
    none = new PermissionsBitField(0n);
  const categories = mapping.map(({ category, team }) => ({
    id: category,
    type: ChannelType.GuildCategory,
    parentId: null,
    permissionOverwrites: {
      cache: new Collection([
        [rosterGuildId, { id: rosterGuildId, type: 0, deny: view, allow: none }],
        [team, { id: team, type: 0, deny: none, allow: view }],
      ]),
    },
    permissionsFor: () => none,
  }));
  const shared = {
    id: "1565003638852550768",
    type: ChannelType.GuildCategory,
    parentId: null,
    permissionsFor: () => view,
  };
  const messageId = "1566934537160761357",
    guidelinesId = "1566875132658458675";
  let edited = false;
  const message = {
    author: { id: "bot" },
    edit: async () => {
      edited = true;
    },
  };
  const guidelines = {
    id: guidelinesId,
    type: ChannelType.GuildText,
    parentId: shared.id,
    isTextBased: () => true,
    permissionsFor: () => view,
    messages: {
      fetch: async (id: string) => {
        if (id !== messageId) throw Error("Unknown Message");
        return message;
      },
    },
  };
  const general = {
    id: "general",
    isTextBased: () => true,
    messages: {
      fetch: async () => {
        throw Error("Unknown Message");
      },
    },
  };
  const channels = new Collection(
    [...categories, shared, guidelines].map((channel) => [channel.id, channel]),
  );
  const guild = {
    id: rosterGuildId,
    roles: { fetch: async () => allRoles },
    channels: { fetch: async (id?: string) => (id ? channels.get(id) : channels) },
    members: {
      fetchMe: async () => ({
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
        roles: { highest: { comparePositionTo: () => 1 } },
      }),
      list: async () => new Collection(),
    },
  };
  const responses: string[] = [];
  const interaction = {
    commandName: "guidelines-renew",
    guildId: rosterGuildId,
    guild,
    channel: general,
    id: "period-id",
    createdTimestamp: 123,
    client: { user: { id: "bot" } },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: {
      getString: (name: string) =>
        ({ period: "Fall", version: "v1", "message-id": messageId })[name],
    },
    deferReply: async () => {},
    editReply: async (text: string) => {
      responses.push(text);
    },
  } as unknown as import("discord.js").ChatInputCommandInteraction;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        yield* guidelinesCommands(store).dispatch(interaction);
        expect(edited).toBe(true);
        expect((yield* store.active(rosterGuildId))?.channelId).toBe(guidelinesId);
        expect(responses.at(-1)).toContain("Started Fall");
      }),
    ),
  );
});
