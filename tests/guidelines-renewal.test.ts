import { expect, test } from "bun:test";
import {
  ChannelType,
  Collection,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Guild,
  type ButtonInteraction,
} from "discord.js";
import { Effect } from "effect";
import { AgreementStore } from "../src/bot/guidelines/AgreementStore";
import {
  agreementButton,
  guidelinesButton,
  renewGuidelines,
} from "../src/bot/guidelines/GuidelinesCommand";
import {
  guidelinesChannelId,
  sharedTeamsCategoryId,
  teamDefinitions,
} from "../src/bot/guidelines/TeamGate";
import { rosterGuildId } from "../src/bot/commands/syncRoster";

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
            rosterGuildId,
            {
              id: rosterGuildId,
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
  const guild = {
    id: rosterGuildId,
    client: { user: { id: "bot" } },
    roles: { fetch: async () => roles },
    channels: { fetch: async (id?: string) => (id ? channels.get(id) : channels) },
    members: {
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
  return { guild, edits, message, period };
}

test("renewal installs a button without rewriting approved text, and only the current button records acceptance", async () => {
  const { guild, edits, message, period } = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        yield* renewGuidelines(guild, store, period);
        expect(edits).toEqual([{ components: [agreementButton(period.id)] }]);
        expect(message.content).toBe("Approved code of conduct");
        expect((yield* store.active(rosterGuildId))?.version).toBe("2026-11-16");
        const replies: unknown[] = [];
        const click = {
          guildId: rosterGuildId,
          customId: `guidelines:agree:${period.id}`,
          channelId: guidelinesChannelId,
          message: { id: period.messageId },
          user: { id: "member", bot: false },
          createdTimestamp: 2000,
          reply: async (payload: unknown) => {
            replies.push(payload);
          },
        } as unknown as ButtonInteraction;
        yield* guidelinesButton(store, click);
        yield* guidelinesButton(store, click);
        expect((yield* store.getAcceptance(period.id, "member"))?.agreedAt).toBe(2000);
        yield* renewGuidelines(guild, store, {
          ...period,
          id: "fall-v2",
          version: "2026-11-17",
          startedAt: 4000,
        });
        yield* guidelinesButton(store, click);
        expect(replies.at(-1)).toMatchObject({
          content: "This agreement is no longer active. Ask an officer for the current one.",
        });
        expect(yield* store.getAcceptance("fall-v2", "member")).toBeNull();
        expect(yield* store.history(rosterGuildId, "member")).toEqual([
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
        yield* store.startPeriod({
          ...period,
          id: "previous",
          guildId: rosterGuildId,
          channelId: guidelinesChannelId,
        });
        yield* renewGuidelines(guild, store, period).pipe(Effect.ignore);
        expect((yield* store.active(rosterGuildId))?.id).toBe("previous");
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
        yield* renewGuidelines(guild, store, period).pipe(Effect.ignore);
        expect(edits).toEqual([]);
        expect(yield* store.active(rosterGuildId)).toBeNull();
      }),
    ),
  );
});
