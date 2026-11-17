import { expect, test } from "bun:test";
import {
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Effect } from "effect";
import { type BackgroundTaskHealth } from "@autorole/discord-framework";
import { healthCommands } from "../src/bot/health/module";

function fixture(
  tasks: readonly BackgroundTaskHealth[],
  permissions = PermissionFlagsBits.ManageGuild,
) {
  const replies: unknown[] = [];
  let reads = 0;
  const interaction = {
    commandName: "bot-status",
    guildId: "guild",
    memberPermissions: new PermissionsBitField(permissions),
    deferReply: async (value: unknown) => {
      replies.push(value);
    },
    editReply: async (value: unknown) => {
      replies.push(value);
    },
  } as unknown as ChatInputCommandInteraction;
  const commands = healthCommands.bind({
    snapshot: Effect.sync(() => {
      reads++;
      return tasks;
    }),
  });
  return {
    replies,
    reads: () => reads,
    run: () => Effect.runPromise(commands.dispatch(interaction)),
  };
}

const history = { lastSuccessAt: null, lastFailure: null, consecutiveFailures: 0 };

test("bot-status privately shows current task health, history, and retry times", async () => {
  const f = fixture([
    { ...history, name: "pending", status: "pending" },
    { ...history, name: "running", status: "running", startedAt: 5_000 },
    { ...history, name: "healthy", status: "healthy", nextRunAt: 60_000, lastSuccessAt: 0 },
    {
      ...history,
      name: "retrying",
      status: "retrying",
      nextRunAt: 60_000,
      consecutiveFailures: 2,
      lastFailure: { at: 0, kind: "defect", message: "Unavailable" },
    },
    {
      ...history,
      name: "stopped",
      status: "stopped",
      reason: "failure",
      consecutiveFailures: 1,
      lastFailure: { at: 0, kind: "failure", message: "Stopped" },
    },
  ]);
  await f.run();
  expect(f.replies).toEqual([
    { flags: MessageFlags.Ephemeral },
    {
      allowedMentions: { parse: [] },
      content: [
        "pending: Waiting for Discord readiness\nLast success: Never\nLast failure: None",
        "running: Running since 1970-01-01T00:00:05.000Z\nLast success: Never\nLast failure: None",
        "healthy: Healthy. Next run: 1970-01-01T00:01:00.000Z\nLast success: 1970-01-01T00:00:00.000Z\nLast failure: None",
        "retrying: Retrying at 1970-01-01T00:01:00.000Z. Consecutive failures: 2\nLast success: Never\nLast failure: 1970-01-01T00:00:00.000Z (defect): Unavailable",
        "stopped: Stopped after failure\nLast success: Never\nLast failure: 1970-01-01T00:00:00.000Z (failure): Stopped",
      ].join("\n\n"),
    },
  ]);
});

test("bot-status enforces Manage Server before reading task health", async () => {
  const f = fixture([], 0n);
  await expect(f.run()).rejects.toThrow("You do not have permission to use this command.");
  expect(f.reads()).toBe(0);
  expect(f.replies).toEqual([]);
});

test("long health reports are attached without losing the failure message", async () => {
  const f = fixture([
    {
      ...history,
      name: "long",
      status: "retrying",
      nextRunAt: 60_000,
      consecutiveFailures: 1,
      lastFailure: { at: 0, message: "x".repeat(3000), kind: "failure" },
    },
  ]);
  await f.run();
  expect(f.replies[0]).toEqual({ flags: MessageFlags.Ephemeral });
  const reply = f.replies[1];
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("files" in reply) ||
    !Array.isArray(reply.files)
  )
    throw new Error("Missing attachment");
  const file = reply.files[0];
  if (!file || !Buffer.isBuffer(file.attachment)) throw new Error("Missing attachment content");
  expect(file.name).toBe("bot-status.txt");
  expect(file.attachment.toString()).toBe(
    `long: Retrying at 1970-01-01T00:01:00.000Z. Consecutive failures: 1\nLast success: Never\nLast failure: 1970-01-01T00:00:00.000Z (failure): ${"x".repeat(3000)}`,
  );
});

test("bot-status handles a runtime with no registered tasks", async () => {
  const f = fixture([]);
  await f.run();
  expect(f.replies[1]).toEqual({
    content: "No background tasks are registered.",
    allowedMentions: { parse: [] },
  });
});
