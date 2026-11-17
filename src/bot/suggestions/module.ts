import { Events, type Client } from "discord.js";
import { Effect } from "effect";
import { buttonEvent, CommandRegistry, event, type BotModule } from "@autorole/discord-framework";
import { featureStatePath, type BotFeature, type BotOptions } from "../feature";
import { Suggestions } from "./Suggestions";

export const suggestionsFeature = {
  definitions: [],
  make: Effect.fn("Suggestions.module")(function* (client: Client, options: BotOptions) {
    const suggestions = yield* Suggestions.make(
      client,
      featureStatePath(options.path, "suggestions"),
    );
    return {
      commands: new CommandRegistry([]),
      events: [
        buttonEvent(
          (interaction) => interaction.customId.startsWith("suggestions:"),
          (interaction) => suggestions.interaction(interaction),
        ),
        event(Events.MessageCreate, (message) => suggestions.message(message)),
        event(Events.MessageUpdate, (_before, message) => suggestions.edited(message)),
      ],
    } satisfies BotModule;
  }),
} satisfies BotFeature;
