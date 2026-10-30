import { expectTypeOf } from "bun:test";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import type { Effect } from "effect";
import { options } from "@autorole/discord-framework";

export function assertOptionTypes(interaction: ChatInputCommandInteraction) {
  const values = options(interaction.options);
  expectTypeOf(values.required.string("text")).toEqualTypeOf<Effect.Effect<string, Error>>();
  expectTypeOf(values.optional.string("text")).toEqualTypeOf<Effect.Effect<string | null, Error>>();
  expectTypeOf(values.required.boolean("boolean")).toEqualTypeOf<Effect.Effect<boolean, Error>>();
  expectTypeOf(values.optional.integer("integer")).toEqualTypeOf<
    Effect.Effect<number | null, Error>
  >();
  expectTypeOf(values.required.channel("channel", [ChannelType.GuildText])).toMatchTypeOf<
    Effect.Effect<{ type: ChannelType.GuildText }, Error>
  >();
}

export function assertCachedTypes(interaction: ChatInputCommandInteraction<"cached">) {
  const values = options(interaction.options);
  expectTypeOf(values.optional.member("member")).toEqualTypeOf<
    Effect.Effect<import("discord.js").GuildMember | null, Error>
  >();
  expectTypeOf(values.required.role("role")).toEqualTypeOf<
    Effect.Effect<import("discord.js").Role, Error>
  >();
}
