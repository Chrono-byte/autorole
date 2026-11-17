export { listen, makeClient, runClient } from "./src/runtime/client";
export { commandPermissions, upsertCommands } from "./src/api/commands";
export {
  CommandCatalog,
  CommandRegistry,
  type Command,
  type CommandDefinition,
  type CommandSpec,
} from "./src/commands/registry";
export { buttonEvent, event, install, type EventHandler } from "./src/runtime/events";
export { composeModules, runBot, type BotModule, type BotModuleFactory } from "./src/runtime/bot";
export { type BackgroundTask, BackgroundTaskTimeout } from "./src/runtime/background";
export {
  BackgroundHealth,
  type BackgroundTaskHealth,
  type BackgroundTaskFailure,
} from "./src/runtime/health";
export { presenceTask } from "./src/runtime/presence";
export { options } from "./src/commands/options";
export {
  checkPermissions,
  PermissionDenied,
  type CommandPermissions,
} from "./src/commands/permissions";
export { DiscordRequestError, discordRequest } from "./src/api/request";
export { roleAssignability } from "./src/api/roles";
export {
  subcommands,
  UnknownSubcommandError,
  type SubcommandRoute,
} from "./src/commands/subcommands";
export {
  deferResponse,
  deferEphemeral,
  editResponse,
  replyEphemeral,
} from "./src/commands/response";
export { fetchGuildMember, forEachGuildMember } from "./src/api/members";

export { messageTransport, WebhookUnavailable, type MessageChannel } from "./src/api/messages";
