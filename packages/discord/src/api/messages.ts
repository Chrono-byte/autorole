import {
  EmbedBuilder,
  type Message,
  type MessageCreateOptions,
  type MessageEditOptions,
  type TextChannel,
} from "discord.js";
import { Effect, Schema } from "effect";
import { discordRequest } from "./request";

export type MessageChannel = {
  send: (options: MessageCreateOptions) => PromiseLike<Message>;
  messages: { edit: (id: string, options: MessageEditOptions) => PromiseLike<unknown> };
};

type MessageBody = {
  source: Pick<Message, "content" | "attachments">;
  content?: string | null;
  embeds?: readonly EmbedBuilder[];
};

type MessageDestination =
  | { type: "channel"; channel: MessageChannel }
  | {
      type: "webhook";
      channel: TextChannel;
      ownerId: string;
      name: string;
      reason: string;
      threadId: string;
      webhookId?: string;
      identity: { username: string; avatarURL: string };
    };

export class WebhookUnavailable extends Schema.TaggedError<WebhookUnavailable>()(
  "WebhookUnavailable",
  {
    message: Schema.String,
  },
) {}

function payload(body: MessageBody) {
  const content = body.content === undefined ? body.source.content : body.content;
  const embeds = [...(body.embeds ?? [])];
  const long = content !== null && content.length > 2000;
  if (long) embeds.push(new EmbedBuilder().setDescription(content));
  const files = [...body.source.attachments.values()].map((attachment) => ({
    attachment: attachment.url,
    name: attachment.name ?? "attachment",
  }));
  return {
    content: long ? null : content || null,
    embeds,
    files,
    allowedMentions: { parse: [] as [], repliedUser: false },
  };
}

export const messageTransport = Effect.fn("Discord.messageTransport")(function* (
  destination: MessageDestination,
) {
  if (destination.type === "channel") {
    const channel = destination.channel;
    return {
      webhookId: null,
      send: (body: MessageBody, replyId?: string) =>
        discordRequest(() => {
          const value = payload(body);
          return channel.send({
            ...value,
            content: value.content ?? undefined,
            ...(replyId ? { reply: { messageReference: replyId, failIfNotExists: false } } : {}),
          });
        }),
      edit: (id: string, body: MessageBody) =>
        discordRequest(() => channel.messages.edit(id, { ...payload(body), attachments: [] })).pipe(
          Effect.asVoid,
        ),
    };
  }
  const hooks = yield* discordRequest(() => destination.channel.fetchWebhooks());
  const found = hooks.find(
    (candidate) =>
      candidate.isIncoming() &&
      candidate.owner?.id === destination.ownerId &&
      candidate.channelId === destination.channel.id &&
      (destination.webhookId
        ? candidate.id === destination.webhookId
        : candidate.name === destination.name),
  );
  if (destination.webhookId && (!found?.isIncoming() || !found.token))
    return yield* new WebhookUnavailable({
      message: "The webhook for this message is unavailable.",
    });
  const hook =
    found?.isIncoming() && found.token
      ? found
      : yield* discordRequest(() =>
          destination.channel.createWebhook({ name: destination.name, reason: destination.reason }),
        );
  return {
    webhookId: hook.id,
    send: (body: MessageBody, _replyId?: string) =>
      discordRequest(() => {
        const value = payload(body);
        return hook.send({
          ...value,
          content: value.content ?? undefined,
          threadId: destination.threadId,
          username: destination.identity.username.slice(0, 80),
          avatarURL: destination.identity.avatarURL,
        });
      }),
    edit: (id: string, body: MessageBody) =>
      discordRequest(() =>
        hook.editMessage(id, { ...payload(body), attachments: [], threadId: destination.threadId }),
      ).pipe(Effect.asVoid),
  };
});
