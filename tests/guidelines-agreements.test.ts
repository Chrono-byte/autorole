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

test("disabling the gate retains agreement history", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        yield* store.startPeriod({
          id: "period",
          guildId: "guild",
          channelId: "channel",
          messageId: "message",
          period: "Fall",
          version: "v1",
          startedAt: 1,
        });
        yield* store.acceptCurrent("guild", "period", "channel", "message", "member", 2);
        yield* store.deactivate("guild");
        expect(yield* store.active("guild")).toBeNull();
        expect((yield* store.getAcceptance("period", "member"))?.agreedAt).toBe(2);
      }),
    ),
  );
});
