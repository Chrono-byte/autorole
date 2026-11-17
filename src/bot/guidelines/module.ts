import { Events, type Client } from "discord.js";
import { Effect } from "effect";
import { buttonEvent, event, type BotModule } from "@autorole/discord-framework";
import { featureStatePath, type BotFeature, type BotOptions } from "../feature";
import { AgreementStore } from "./AgreementStore";
import { guidelinesButton, guidelinesCommands, isGuidelinesButton } from "./GuidelinesCommand";
import { teamDefinitions } from "./TeamGate";
import { GuidelinesCoordinator } from "./GuidelinesCoordinator";

export const guidelinesFeature = {
  definitions: guidelinesCommands.definitions,
  make: Effect.fn("Guidelines.module")(function* (client: Client, options: BotOptions) {
    const store = yield* AgreementStore.make(featureStatePath(options.path, "guidelines"));
    const guidelines = new GuidelinesCoordinator(store);
    return {
      commands: guidelinesCommands.bind(guidelines),
      background: [
        {
          name: "guidelines-gate",
          interval: "1 minute",
          onFailure: "continue",
          run: () => guidelines.refresh(client),
        },
      ],
      events: [
        buttonEvent(isGuidelinesButton, (interaction) => guidelinesButton(guidelines, interaction)),
        event(Events.GuildMemberUpdate, (before, member) =>
          teamDefinitions.some((team) =>
            team.identity.some((id) => before.roles.cache.has(id) !== member.roles.cache.has(id)),
          )
            ? guidelines.reconcileMember(member)
            : Effect.void,
        ),
      ],
    } satisfies BotModule;
  }),
} satisfies BotFeature;
