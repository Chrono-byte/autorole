import { expect, test } from "bun:test";
import {
  ChannelType,
  Collection,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Guild,
  type Client,
  type ButtonInteraction,
} from "discord.js";
import { Effect, Fiber, Result } from "effect";
import { GuidelinesCoordinator } from "../src/bot/guidelines/GuidelinesCoordinator";
import { agreementButton } from "../src/bot/guidelines/AgreementPanel";
import { AgreementStore } from "../src/bot/guidelines/AgreementStore";
import { guidelinesButton } from "../src/bot/guidelines/GuidelinesCommand";
import {
  guidelinesChannelId,
  sharedTeamsCategoryId,
  teamDefinitions,
} from "../src/bot/guidelines/TeamGate";
import { guildId } from "../src/config/discord";

function fixture() {
  const edits: unknown[] = [];
  const message = {
    author: { id: "bot" },
    content: "Approved code of conduct",
    embeds: [],
    edit: async (payload: unknown) => {
      edits.push(payload);
    },
  };
  const roles = new Collection<
    string,
    { id: string; name: string; managed: boolean; permissions: PermissionsBitField }
  >();
  const channels = new Collection<string, unknown>();
  for (const [index, team] of teamDefinitions.entries()) {
    for (const id of [...team.identity, `access-${index}`])
      roles.set(id, {
        id,
        name: id === `access-${index}` ? team.accessName : id,
        managed: false,
        permissions: new PermissionsBitField(0n),
      });
    channels.set(team.category, {
      id: team.category,
      type: ChannelType.GuildCategory,
      parentId: null,
      permissionOverwrites: {
        cache: new Collection([
          [
            guildId,
            {
              id: guildId,
              type: 0,
              allow: new PermissionsBitField(0n),
              deny: new PermissionsBitField(P.ViewChannel),
            },
          ],
          [
            `access-${index}`,
            {
              id: `access-${index}`,
              type: 0,
              allow: new PermissionsBitField(P.ViewChannel),
              deny: new PermissionsBitField(0n),
            },
          ],
        ]),
      },
    });
  }
  const channel = {
    id: guidelinesChannelId,
    type: ChannelType.GuildText,
    parentId: sharedTeamsCategoryId,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(P.ViewChannel | P.ReadMessageHistory),
    messages: { fetch: async () => message },
  };
  channels.set(guidelinesChannelId, channel);
  const held = new Set(teamDefinitions.flatMap((team) => team.identity));
  const member = {
    id: "member",
    user: { bot: false },
    roles: {
      get cache() {
        return new Collection([...held].map((id) => [id, { id }]));
      },
      add: async (id: string) => {
        held.add(id);
      },
      remove: async (id: string) => {
        held.delete(id);
      },
    },
  };
  const guild = {
    id: guildId,
    client: { user: { id: "bot" } },
    roles: { fetch: async () => roles },
    channels: { fetch: async (id?: string) => (id ? channels.get(id) : channels) },
    members: {
      list: async () => new Collection([[member.id, member]]),
      fetch: async () => member,
      fetchMe: async () => ({
        permissions: new PermissionsBitField(P.Administrator),
        roles: { highest: { comparePositionTo: () => 1 } },
      }),
    },
  } as unknown as Guild;
  const period = {
    id: "fall-v1",
    period: "Fall 2026",
    version: "2026-11-16",
    messageId: "1566933194370977945",
    startedAt: 1000,
  };
  return { guild, edits, message, period, member, held };
}

test("periodic guidelines health reports incomplete updates and recovers on a later pass", async () => {
  const { guild, member, held } = fixture();
  const client = {
    guilds: { cache: new Collection([[guildId, guild]]) },
  } as unknown as Client;
  member.roles.add = async () => {
    throw new Error("Unavailable");
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const guidelines = new GuidelinesCoordinator(store);
        const failed = yield* Effect.result(guidelines.refresh(client));
        expect(Result.isFailure(failed)).toBe(true);
        member.roles.add = async (id) => {
          held.add(id);
        };
        yield* guidelines.refresh(client);
        expect(held.has("access-0")).toBe(true);
      }),
    ),
  );
});

test("concurrent renewals keep the installed button and active period in the same order", async () => {
  const { guild, edits, message, period } = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const edit = message.edit;
  message.edit = async (payload) => {
    await edit(payload);
    if (edits.length === 1) {
      entered.resolve();
      await release.promise;
    }
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const guidelines = new GuidelinesCoordinator(store);
        const first = yield* Effect.forkChild(guidelines.renew(guild, period), {
          startImmediately: true,
        });
        yield* Effect.tryPromise(() => entered.promise);
        const second = yield* Effect.forkChild(
          guidelines.renew(guild, { ...period, id: "second" }),
          { startImmediately: true },
        );
        expect(edits).toEqual([{ components: [agreementButton(period.id)] }]);
        release.resolve();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(edits).toEqual([
          { components: [agreementButton(period.id)] },
          { components: [agreementButton("second")] },
        ]);
        expect((yield* store.active(guildId))?.id).toBe("second");
      }),
    ),
  );
});

test("renewal waits for prior access writes before activating its period", async () => {
  const { guild, message, period, member, held } = fixture();
  const writing = Promise.withResolvers<void>();
  const edited = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  member.roles.add = async (id) => {
    writing.resolve();
    await release.promise;
    held.add(id);
  };
  message.edit = async () => {
    edited.resolve();
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const guidelines = new GuidelinesCoordinator(store);
        const access = yield* Effect.forkChild(guidelines.reconcile(guild), {
          startImmediately: true,
        });
        yield* Effect.tryPromise(() => writing.promise);
        const renewal = yield* Effect.forkChild(guidelines.renew(guild, period), {
          startImmediately: true,
        });
        yield* Effect.tryPromise(() => edited.promise);
        expect(yield* store.active(guildId)).toBeNull();
        release.resolve();
        yield* Fiber.join(access);
        yield* Fiber.join(renewal);
        expect((yield* store.active(guildId))?.id).toBe(period.id);
        expect((yield* guidelines.reconcile(guild)).changed).toBe(1);
        expect([...held]).toEqual(teamDefinitions.flatMap((team) => team.identity));
      }),
    ),
  );
});

test("renewal installs a button without rewriting approved text, and only the current button records acceptance", async () => {
  const { guild, edits, message, period } = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const guidelines = new GuidelinesCoordinator(store);
        yield* guidelines.renew(guild, period);
        expect(edits).toEqual([{ components: [agreementButton(period.id)] }]);
        expect(message.content).toBe("Approved code of conduct");
        expect((yield* store.active(guildId))?.version).toBe("2026-11-16");
        const replies: unknown[] = [];
        const click = {
          guildId: guildId,
          customId: `guidelines:agree:${period.id}`,
          channelId: guidelinesChannelId,
          message: { id: period.messageId },
          user: { id: "member", bot: false },
          createdTimestamp: 2000,
          reply: async (payload: unknown) => {
            replies.push(payload);
          },
        } as unknown as ButtonInteraction;
        yield* guidelinesButton(guidelines, click);
        yield* guidelinesButton(guidelines, click);
        expect((yield* store.getAcceptance(period.id, "member"))?.agreedAt).toBe(2000);
        yield* guidelines.renew(guild, {
          ...period,
          id: "fall-v2",
          version: "2026-11-17",
          startedAt: 4000,
        });
        yield* guidelinesButton(guidelines, click);
        expect(replies.at(-1)).toMatchObject({
          content: "This agreement is no longer active. Ask an officer for the current one.",
        });
        expect(yield* store.getAcceptance("fall-v2", "member")).toBeNull();
        expect(yield* store.history(guildId, "member")).toEqual([
          { period: "Fall 2026", version: "2026-11-16", agreedAt: 2000, source: "member" },
        ]);
      }),
    ),
  );
});

test("failed panel updates leave the previous agreement active", async () => {
  const { guild, message, period } = fixture();
  message.edit = async () => {
    throw new Error("Discord unavailable");
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const guidelines = new GuidelinesCoordinator(store);
        yield* store.startPeriod({
          ...period,
          id: "previous",
          guildId: guildId,
          channelId: guidelinesChannelId,
        });
        yield* guidelines.renew(guild, period).pipe(Effect.ignore);
        expect((yield* store.active(guildId))?.id).toBe("previous");
      }),
    ),
  );
});

test("renewal refuses to attach agreement controls to someone else's message", async () => {
  const { guild, edits, message, period } = fixture();
  message.author.id = "another-bot";
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const guidelines = new GuidelinesCoordinator(store);
        yield* guidelines.renew(guild, period).pipe(Effect.ignore);
        expect(edits).toEqual([]);
        expect(yield* store.active(guildId)).toBeNull();
      }),
    ),
  );
});
