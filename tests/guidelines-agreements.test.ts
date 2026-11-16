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

test("channel access roles preserve team membership and follow the current agreement", async () => {
  const { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } =
    await import("discord.js");
  const { reconcileTeamGate } = await import("../src/bot/guidelines/TeamGate");
  const { rosterGuildId } = await import("../src/bot/commands/syncRoster");
  const mapping = [
    { category: "category", identity: ["team", "sub"], accessName: "Access", access: "access" },
  ];
  const assigned = new Set(["team", "captain", "access"]);
  const member = {
    id: "member",
    user: { bot: false },
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
    ["team", "sub", "access", "captain"].map((id) => [
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
      "access",
      {
        id: "access",
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
    id: "1566875132658458675",
    type: ChannelType.GuildText,
    parentId: "1565003638852550768",
    permissionsFor: () =>
      new PermissionsBitField(
        PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory,
      ),
  };
  const guild = {
    id: rosterGuildId,
    ownerId: "owner",
    roles: { fetch: async () => roles },
    channels: {
      fetch: async () =>
        new Collection<string, unknown>([
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
        });
        expect([...assigned].toSorted()).toEqual(["captain", "team"]);
        yield* store.acceptCurrent(rosterGuildId, "period", "channel", "message", "member", 2);
        expect(yield* reconcileTeamGate(guild, store, mapping)).toEqual({
          changed: 1,
          failed: [],
        });
        expect([...assigned].toSorted()).toEqual(["access", "captain", "team"]);
        expect((yield* reconcileTeamGate(guild, store, mapping)).changed).toBe(0);
        yield* store.startPeriod({
          id: "renewed",
          guildId: rosterGuildId,
          channelId: "channel",
          messageId: "message",
          period: "Fall",
          version: "2",
          startedAt: 3,
        });
        expect((yield* reconcileTeamGate(guild, store, mapping)).changed).toBe(1);
        expect([...assigned].toSorted()).toEqual(["captain", "team"]);
        yield* store.acceptCurrent(rosterGuildId, "renewed", "channel", "message", "member", 4);
        expect((yield* reconcileTeamGate(guild, store, mapping)).changed).toBe(1);
        assigned.delete("team");
        expect((yield* reconcileTeamGate(guild, store, mapping)).changed).toBe(1);
        expect([...assigned]).toEqual(["captain"]);
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

test("team access uses current membership and agreement, including substitutes and multiple teams", async () => {
  const { desiredTeamAccess } = await import("../src/bot/guidelines/TeamGate");
  const mapping = [
    {
      category: "red",
      accessName: "Red Access",
      identity: ["red-player", "red-sub"],
      access: "red-access",
    },
    {
      category: "white",
      accessName: "White Access",
      identity: ["white-player", "white-sub"],
      access: "white-access",
    },
  ];
  expect(desiredTeamAccess(new Set(["red-sub", "white-player"]), mapping, true)).toEqual([
    { access: "red-access", allowed: true },
    { access: "white-access", allowed: true },
  ]);
  expect(desiredTeamAccess(new Set(["red-player", "white-sub"]), mapping, false)).toEqual([
    { access: "red-access", allowed: false },
    { access: "white-access", allowed: false },
  ]);
  expect(desiredTeamAccess(new Set(["red-access", "white-access"]), mapping, true)).toEqual([
    { access: "red-access", allowed: false },
    { access: "white-access", allowed: false },
  ]);
});

test("administrative grants preserve personal agreements, are scoped to one period, and become personal only on a click", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const period = {
          id: "current",
          guildId: "guild",
          channelId: "channel",
          messageId: "message",
          period: "Fall 2026",
          version: "2026-11-16",
          startedAt: 10,
        };
        yield* store.startPeriod(period);
        yield* store.acceptCurrent("guild", "current", "channel", "message", "already-agreed", 20);
        expect(
          yield* store.grantCurrent("guild", "current", ["already-agreed", "grandfathered"], 30),
        ).toBe(1);
        expect(yield* store.getAcceptance("current", "already-agreed")).toMatchObject({
          agreedAt: 20,
          source: "member",
        });
        expect(yield* store.getAcceptance("current", "grandfathered")).toMatchObject({
          agreedAt: 30,
          source: "admin",
        });
        expect(yield* store.getAcceptance("current", "later-joiner")).toBeNull();
        expect(yield* store.grantCurrent("guild", "current", ["grandfathered"], 40)).toBe(0);
        expect((yield* store.getAcceptance("current", "grandfathered"))?.agreedAt).toBe(30);
        yield* store.acceptCurrent("guild", "current", "channel", "message", "grandfathered", 50);
        expect(yield* store.getAcceptance("current", "grandfathered")).toMatchObject({
          agreedAt: 50,
          source: "member",
        });
        yield* store.acceptCurrent("guild", "current", "channel", "message", "grandfathered", 60);
        expect((yield* store.getAcceptance("current", "grandfathered"))?.agreedAt).toBe(50);
        yield* store.startPeriod({ ...period, id: "next", version: "next" });
        expect(yield* store.grantCurrent("guild", "current", ["late"], 70)).toBe(0);
        expect(yield* store.getAcceptance("next", "grandfathered")).toBeNull();
      }),
    ),
  );
});

test("source migration preserves existing personal agreement dates across reopen", async () => {
  const { Database } = await import("bun:sqlite");
  const directory = mkdtempSync(join(tmpdir(), "agreement-source-"));
  const path = join(directory, "agreements.sqlite");
  const legacy = new Database(path);
  legacy.run(
    "CREATE TABLE guideline_period_acceptances (periodId TEXT NOT NULL, memberId TEXT NOT NULL, agreedAt INTEGER NOT NULL, PRIMARY KEY(periodId, memberId))",
  );
  legacy.run("INSERT INTO guideline_period_acceptances VALUES ('period', 'member', 1234)");
  legacy.close();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* AgreementStore.make(path);
            expect(yield* store.getAcceptance("period", "member")).toEqual({
              periodId: "period",
              memberId: "member",
              agreedAt: 1234,
              source: "member",
            });
          }),
        ),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
