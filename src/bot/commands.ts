import { CommandCatalog } from "@autorole/discord-framework";
import { autoroleCommands } from "./commands/AutoroleCommands";
import { guidelinesCommands } from "./guidelines/GuidelinesCommand";
import { serverStatsCommands } from "./member-counter/ServerStatsCommand";
import { type RoleService } from "./RoleService";
import { type AgreementStore } from "./guidelines/AgreementStore";
import { type StatsStore } from "./member-counter/StatsStore";

type CommandDependencies = {
  roles: RoleService;
  stats: StatsStore;
  agreements: AgreementStore;
};

export const commandCatalog = CommandCatalog.combine([
  autoroleCommands.mapContext(({ roles }: CommandDependencies) => roles),
  serverStatsCommands.mapContext(({ stats }: CommandDependencies) => stats),
  guidelinesCommands.mapContext(({ agreements }: CommandDependencies) => agreements),
]);
