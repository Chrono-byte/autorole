import { type BotModuleFactory } from "@autorole/discord-framework";
import { assignmentFeature } from "./assignments/module";
import { suggestionsFeature } from "./suggestions/module";
import { memberCounterFeature } from "./member-counter/module";
import { guidelinesFeature } from "./guidelines/module";
import { healthFeature } from "./health/module";
import { type BotFeature, type BotOptions } from "./feature";

const features: readonly BotFeature[] = [
  assignmentFeature,
  suggestionsFeature,
  memberCounterFeature,
  guidelinesFeature,
  healthFeature,
];

export const commandDefinitions = features.flatMap((feature) => feature.definitions);

export function autoroleModules(options: BotOptions): BotModuleFactory[] {
  return features.map((feature) => (client) => feature.make(client, options));
}
