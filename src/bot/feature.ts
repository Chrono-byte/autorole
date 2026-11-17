import { type Client } from "discord.js";
import { type Effect, type Scope } from "effect";
import { type BotModule, type CommandDefinition } from "@autorole/discord-framework";

export type BotOptions = {
  path: string;
  guildId?: string;
  report: (error: unknown, guildId: string, memberId: string) => Effect.Effect<void>;
};

export type BotFeature = {
  definitions: readonly CommandDefinition[];
  make: (client: Client, options: BotOptions) => Effect.Effect<BotModule, Error, Scope.Scope>;
};

export const featureStatePath = (path: string, feature: string) =>
  path === ":memory:" ? path : `${path}.${feature}`;
