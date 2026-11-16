import { expect, test } from "bun:test";
import { MessageFlags, PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { Effect, Result } from "effect";
import { AgreementStore } from "../src/bot/guidelines/AgreementStore";
import { guidelinesCommands } from "../src/bot/guidelines/GuidelinesCommand";

function interactionFixture(permissions = 32n) {
  const replies: unknown[] = [];
  const interaction = {
    commandName: "guidelines-status",
    guildId: "guild",
    guild: { id: "guild" },
    memberPermissions: new PermissionsBitField(permissions),
    options: { getUser: () => ({ id: "member" }) },
    deferReply: async (payload: unknown) => {
      replies.push(payload);
    },
    editReply: async (payload: unknown) => {
      replies.push(payload);
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
}

test("officers can inspect preserved agreements without a configured or active team gate", async () => {
  const { interaction, replies } = interactionFixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        yield* store.startPeriod({
          id: "fall",
          guildId: "guild",
          channelId: "channel",
          messageId: "message",
          period: "Fall 2026",
          version: "v1",
          startedAt: 1000,
        });
        yield* store.acceptCurrent("guild", "fall", "channel", "message", "member", 2000);
        yield* store.deactivate("guild");
        yield* guidelinesCommands.bind(store).dispatch(interaction);
      }),
    ),
  );
  expect(replies).toEqual([
    { flags: MessageFlags.Ephemeral },
    "Agreement history for member:\nNo active agreement period.\n\nFall 2026 (version v1): <t:2:f>",
  ]);
});

test("inspection distinguishes previous agreement from agreement to the current version", async () => {
  const { interaction, replies } = interactionFixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const period = {
          id: "fall",
          guildId: "guild",
          channelId: "channel",
          messageId: "message",
          period: "Fall 2026",
          version: "v1",
          startedAt: 1000,
        };
        yield* store.startPeriod(period);
        yield* store.acceptCurrent("guild", "fall", "channel", "message", "member", 2000);
        yield* store.startPeriod({ ...period, id: "revised", version: "v2", startedAt: 3000 });
        yield* guidelinesCommands.bind(store).dispatch(interaction);
      }),
    ),
  );
  expect(replies[1]).toBe(
    "Agreement history for member:\nFall 2026 (version v2): Not yet agreed.\n\nFall 2026 (version v1): <t:2:f>",
  );
});

test("agreement inspection remains restricted to Manage Server", async () => {
  const { interaction, replies } = interactionFixture(0n);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        const result = yield* Effect.result(guidelinesCommands.bind(store).dispatch(interaction));
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.message).toBe("You do not have permission to use this command.");
      }),
    ),
  );
  expect(replies).toEqual([]);
});

test("long agreement histories retain more than 25 records and use a private attachment", async () => {
  const { interaction, replies } = interactionFixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        for (let i = 0; i < 26; i++) {
          yield* store.startPeriod({
            id: `period-${i}`,
            guildId: "guild",
            channelId: "channel",
            messageId: "message",
            period: `Semester ${i}`,
            version: "v".repeat(80),
            startedAt: i * 1000,
          });
          yield* store.acceptCurrent(
            "guild",
            `period-${i}`,
            "channel",
            "message",
            "member",
            i * 1000,
          );
        }
        expect(yield* store.history("guild", "member")).toHaveLength(26);
        yield* guidelinesCommands.bind(store).dispatch(interaction);
      }),
    ),
  );
  expect(replies[0]).toEqual({ flags: MessageFlags.Ephemeral });
  expect(replies[1]).toMatchObject({
    content: expect.stringContaining("Full history attached."),
    files: [
      expect.objectContaining({ name: "agreement-history.txt", attachment: expect.any(Buffer) }),
    ],
  });
});

test("administrative access grants are labeled separately from personal agreements", async () => {
  const { interaction, replies } = interactionFixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AgreementStore.make(":memory:");
        yield* store.startPeriod({
          id: "fall",
          guildId: "guild",
          channelId: "channel",
          messageId: "message",
          period: "Fall 2026",
          version: "2026-11-16",
          startedAt: 1000,
        });
        yield* store.grantCurrent("guild", "fall", ["member"], 2000);
        yield* guidelinesCommands.bind(store).dispatch(interaction);
      }),
    ),
  );
  expect(replies[1]).toBe(
    "Agreement history for member:\nFall 2026 (version 2026-11-16): Access granted administratively <t:2:f>.\n\nFall 2026 (version 2026-11-16): Administrative access grant <t:2:f>",
  );
});
