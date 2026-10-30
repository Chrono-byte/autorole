import { expect, test } from "bun:test";
import {
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  CommandInteractionOptionResolver,
} from "discord.js";
import { Effect, Result } from "effect";
import { options } from "@autorole/discord-framework";

function fixture() {
  const client = new Client({ intents: [] });
  const resolver = Reflect.construct(CommandInteractionOptionResolver, [
    client,
    [
      { name: "text", type: ApplicationCommandOptionType.String, value: "hello" },
      { name: "integer", type: ApplicationCommandOptionType.Integer, value: 7 },
      { name: "number", type: ApplicationCommandOptionType.Number, value: 2.5 },
      { name: "boolean", type: ApplicationCommandOptionType.Boolean, value: false },
      { name: "user", type: ApplicationCommandOptionType.User, user: { id: "user" } },
      { name: "role", type: ApplicationCommandOptionType.Role, role: { id: "role" } },
      {
        name: "mention-user",
        type: ApplicationCommandOptionType.Mentionable,
        user: { id: "user" },
      },
      {
        name: "mention-role",
        type: ApplicationCommandOptionType.Mentionable,
        role: { id: "role" },
      },
      {
        name: "channel",
        type: ApplicationCommandOptionType.Channel,
        channel: { id: "channel", type: ChannelType.GuildText },
      },
      {
        name: "attachment",
        type: ApplicationCommandOptionType.Attachment,
        attachment: { id: "attachment" },
      },
    ],
    null,
  ]) as CommandInteractionOptionResolver;
  return { client, values: options(resolver) };
}

test("required and optional option readers preserve discord.js behavior", async () => {
  const { client, values } = fixture();
  try {
    expect(await Effect.runPromise(values.required.string("text"))).toBe("hello");
    expect(await Effect.runPromise(values.required.integer("integer"))).toBe(7);
    expect(await Effect.runPromise(values.required.number("number"))).toBe(2.5);
    expect(await Effect.runPromise(values.required.boolean("boolean"))).toBe(false);
    expect((await Effect.runPromise(values.required.user("user"))).id).toBe("user");
    expect((await Effect.runPromise(values.required.role("role"))).id).toBe("role");
    const mentionedUser: unknown = await Effect.runPromise(
      values.required.mentionable("mention-user"),
    );
    const mentionedRole: unknown = await Effect.runPromise(
      values.optional.mentionable("mention-role"),
    );
    expect(mentionedUser).toEqual({
      id: "user",
    });
    expect(mentionedRole).toEqual({
      id: "role",
    });
    expect(
      (await Effect.runPromise(values.required.channel("channel", [ChannelType.GuildText]))).id,
    ).toBe("channel");
    expect((await Effect.runPromise(values.required.attachment("attachment"))).id).toBe(
      "attachment",
    );
    expect(await Effect.runPromise(values.optional.string("missing"))).toBeNull();
    expect(await Effect.runPromise(values.optional.member("user"))).toBeNull();
    const missing = await Effect.runPromise(Effect.result(values.required.string("missing")));
    expect(Result.isFailure(missing)).toBe(true);
    if (Result.isFailure(missing)) expect(missing.failure.message).toContain("missing");
    const wrongType = await Effect.runPromise(Effect.result(values.optional.string("integer")));
    expect(Result.isFailure(wrongType)).toBe(true);
    const wrongChannel = await Effect.runPromise(
      Effect.result(values.required.channel("channel", [ChannelType.GuildVoice])),
    );
    expect(Result.isFailure(wrongChannel)).toBe(true);
  } finally {
    await client.destroy();
  }
});
