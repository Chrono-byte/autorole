import { expect, test } from "bun:test";
import {
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Effect, Result } from "effect";
import { checkPermissions, PermissionDenied } from "@autorole/discord-framework";

function interaction(
  options: { guildId?: string | null; member?: bigint | null; bot?: bigint | null } = {},
) {
  return {
    guildId: options.guildId ?? null,
    memberPermissions: options.member == null ? null : new PermissionsBitField(options.member),
    appPermissions: options.bot == null ? null : new PermissionsBitField(options.bot),
  } as unknown as ChatInputCommandInteraction;
}

const manage = PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles;

test("runtime permissions require all declared member and bot permissions", async () => {
  const allowed = interaction({
    guildId: "guild",
    member: manage,
    bot: PermissionFlagsBits.ManageRoles,
  });
  await Effect.runPromise(
    checkPermissions(allowed, {
      guildOnly: true,
      member: manage,
      bot: PermissionFlagsBits.ManageRoles,
    }),
  );
  for (const member of [null, PermissionFlagsBits.ManageGuild, 0n]) {
    const result = await Effect.runPromise(
      Effect.result(
        checkPermissions(interaction({ guildId: "guild", member }), {
          member: manage,
          deniedMessage: "Manage both permissions.",
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(PermissionDenied);
      expect(result.failure.reason).toBe("member");
      expect(result.failure.message).toBe("Manage both permissions.");
    }
  }
  const missingBot = await Effect.runPromise(
    Effect.result(
      checkPermissions(interaction({ guildId: "guild", member: manage }), {
        member: manage,
        bot: PermissionFlagsBits.ManageRoles,
      }),
    ),
  );
  expect(Result.isFailure(missingBot)).toBe(true);
  if (Result.isFailure(missingBot)) expect(missingBot.failure.reason).toBe("bot");
});

test("guild-only commands fail closed outside a server and administrator satisfies member permissions", async () => {
  const denied = await Effect.runPromise(
    Effect.result(checkPermissions(interaction(), { guildOnly: true })),
  );
  expect(Result.isFailure(denied)).toBe(true);
  if (Result.isFailure(denied)) expect(denied.failure.reason).toBe("guild");
  await Effect.runPromise(
    checkPermissions(interaction({ guildId: "guild", member: PermissionFlagsBits.Administrator }), {
      guildOnly: true,
      member: manage,
    }),
  );
  await Effect.runPromise(checkPermissions(interaction(), {}));
});
