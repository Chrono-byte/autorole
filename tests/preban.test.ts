import { expect, test } from "bun:test";
import {
  DiscordAPIError,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Effect } from "effect";
import { autoroleCommands } from "../src/bot/commands/AutoroleCommands";
import { RoleService } from "../src/bot/RoleService";

const actorId = "100000000000000001";
const targetId = "100000000000000002";
const ownerId = "100000000000000003";
const botId = "100000000000000004";

function fixture(
  options: {
    actorId?: string;
    targetId?: string;
    targetPosition?: number;
    targetError?: Error;
  } = {},
) {
  const bans: string[] = [];
  const replies: unknown[] = [];
  const deferrals: unknown[] = [];
  const actor = options.actorId ?? actorId;
  const target = options.targetId ?? targetId;
  const interaction = {
    commandName: "preban",
    guildId: "guild",
    user: { id: actor },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.BanMembers),
    appPermissions: new PermissionsBitField(PermissionFlagsBits.BanMembers),
    options: { getString: (name: string) => (name === "user-id" ? target : "test") },
    client: {
      user: { id: botId },
      users: {
        fetch: async () => ({ tag: "target", displayAvatarURL: () => "https://example.com/a.png" }),
      },
    },
    guild: {
      ownerId,
      members: {
        fetch: async ({ user }: { user: string }) => {
          if (user === target && options.targetError) throw options.targetError;
          return {
            roles: {
              highest: {
                position: user === actor ? 5 : (options.targetPosition ?? 1),
                comparePositionTo: (role: { position: number }) => 5 - role.position,
              },
            },
          };
        },
        ban: async (id: string) => {
          bans.push(id);
        },
      },
    },
    deferReply: async (reply: unknown) => {
      deferrals.push(reply);
    },
    reply: async (reply: unknown) => {
      replies.push(reply);
    },
    editReply: async (reply: unknown) => {
      replies.push(reply);
    },
  } as unknown as ChatInputCommandInteraction;
  const run = () =>
    Effect.runPromise(autoroleCommands.bind(new RoleService()).dispatch(interaction));
  return { bans, replies, deferrals, run };
}

for (const position of [5, 10]) {
  test(`preban refuses a member at role position ${position} when the caller is at 5`, async () => {
    const f = fixture({ targetPosition: position });
    await f.run();
    expect(f.bans).toEqual([]);
    expect(f.deferrals).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(f.replies).toContain("Your highest role must be above the member you want to ban.");
  });
}

test("preban refuses self, the bot, and the server owner", async () => {
  for (const target of [actorId, botId, ownerId]) {
    const f = fixture({ targetId: target });
    await f.run();
    expect(f.bans).toEqual([]);
  }
});

test("preban permits a lower-ranked member and lets the owner ban a higher-ranked member", async () => {
  for (const options of [{}, { actorId: ownerId, targetPosition: 10 }]) {
    const f = fixture(options);
    await f.run();
    expect(f.bans).toEqual([targetId]);
  }
});

test("preban preserves bans for users outside the guild", async () => {
  const f = fixture({
    targetError: new DiscordAPIError(
      { code: 10007, message: "Unknown Member" },
      10007,
      404,
      "GET",
      "/guilds/guild/members/target",
      {},
    ),
  });
  await f.run();
  expect(f.bans).toEqual([targetId]);
});

test("preban fails closed when the target member cannot be checked", async () => {
  const f = fixture({ targetError: new Error("Discord unavailable") });
  await expect(f.run()).rejects.toThrow("Discord unavailable");
  expect(f.bans).toEqual([]);
});
