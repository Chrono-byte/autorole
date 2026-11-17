import {
  ApplicationIntegrationType,
  AttachmentBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { DateTime, Effect } from "effect";
import {
  BackgroundHealth,
  CommandCatalog,
  deferEphemeral,
  editResponse,
  type BackgroundTaskHealth,
} from "@autorole/discord-framework";
import { type BotFeature } from "../feature";

const timestamp = (at: number | null) =>
  at === null ? "Never" : DateTime.formatIso(DateTime.makeUnsafe(at));

function taskReport(task: BackgroundTaskHealth) {
  let status: string;
  switch (task.status) {
    case "pending":
      status = "Waiting for Discord readiness";
      break;
    case "running":
      status = `Running since ${timestamp(task.startedAt)}`;
      break;
    case "healthy":
      status = `Healthy. Next run: ${timestamp(task.nextRunAt)}`;
      break;
    case "retrying":
      status = `Retrying at ${timestamp(task.nextRunAt)}. Consecutive failures: ${task.consecutiveFailures}`;
      break;
    case "stopped":
      status = task.reason === "failure" ? "Stopped after failure" : "Stopped for shutdown";
      break;
    default: {
      const exhaustive: never = task;
      return exhaustive;
    }
  }
  const failure = task.lastFailure;
  return `${task.name}: ${status}\nLast success: ${timestamp(task.lastSuccessAt)}\nLast failure: ${failure ? `${timestamp(failure.at)} (${failure.kind}): ${failure.message}` : "None"}`;
}

export const healthCommands = new CommandCatalog<BackgroundHealth["Service"]>([
  {
    definition: new SlashCommandBuilder()
      .setName("bot-status")
      .setDescription("Check background task health and recent failures")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setContexts(InteractionContextType.Guild)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall),
    permissions: { guildOnly: true, member: PermissionFlagsBits.ManageGuild },
    run: (health, interaction) =>
      Effect.gen(function* () {
        yield* deferEphemeral(interaction);
        const tasks = yield* health.snapshot;
        const report = tasks.map(taskReport).join("\n\n") || "No background tasks are registered.";
        yield* editResponse(
          interaction,
          report.length <= 2000
            ? { content: report, allowedMentions: { parse: [] } }
            : { files: [new AttachmentBuilder(Buffer.from(report), { name: "bot-status.txt" })] },
        );
      }),
  },
]);

export const healthFeature = {
  definitions: healthCommands.definitions,
  make: Effect.fn("Health.module")(function* () {
    const health = yield* BackgroundHealth;
    return { commands: healthCommands.bind(health), events: [] };
  }),
} satisfies BotFeature;
