import { type Message, type MessageCreateOptions } from "discord.js";
import { Effect } from "effect";
import { discordRequest } from "./request";

/** Relay text and attachments without forwarding mentions or bot-generated embeds. */
export const forwardMessage = Effect.fn("Discord.forwardMessage")(function* (
  message: Message,
  destination: { send: (options: MessageCreateOptions) => PromiseLike<unknown> },
) {
  const files = [...message.attachments.values()].map((attachment) => ({
    attachment: attachment.url,
    name: attachment.name ?? "attachment",
  }));
  yield* discordRequest(async () => {
    await destination.send({
      content: message.content || undefined,
      files,
      allowedMentions: { parse: [] },
    });
  });
});
