import { expect, test } from "bun:test";
import { Client, Events, MessageFlags, type Interaction } from "discord.js";
import { Effect } from "effect";
import { buttonEvent, CommandRegistry, install } from "@autorole/discord-framework";
import { tryPromise } from "../src/effectful";

test("button events ignore other buttons and report failures with a private response", async () => {
  const client = new Client({ intents: [] });
  const delivered = Promise.withResolvers<void>();
  const errors: string[] = [];
  const responses: unknown[] = [];
  const makeInteraction = (customId: string) =>
    ({
      customId,
      isButton: () => true,
      isChatInputCommand: () => false,
      deferred: false,
      replied: false,
      reply: async (payload: unknown) => {
        responses.push(payload);
        delivered.resolve();
      },
    }) as unknown as Interaction;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* install(
            client,
            new CommandRegistry([]),
            [
              buttonEvent(
                (button) => button.customId === "test",
                () => Effect.fail(new Error("private error")),
              ),
            ],
            (error) =>
              Effect.sync(() => {
                errors.push(error.message);
              }),
          );
          client.emit(Events.InteractionCreate, makeInteraction("other"));
          client.emit(Events.InteractionCreate, makeInteraction("test"));
          yield* tryPromise(() => delivered.promise);
        }),
      ),
    );
    expect(errors).toEqual(["private error"]);
    expect(responses).toEqual([
      { content: "Something went wrong. Please try again.", flags: MessageFlags.Ephemeral },
    ]);
    expect(client.listenerCount(Events.InteractionCreate)).toBe(0);
  } finally {
    await client.destroy();
  }
});
