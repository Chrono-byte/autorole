import {
  EmbedBuilder,
  type Client,
  type Message,
  type PartialMessage,
  type TextChannel,
} from "discord.js";
import { Effect, Result } from "effect";
import { discordRequest, messageTransport, type MessageChannel } from "@autorole/discord-framework";
import { ConfigurationError, DiscordRequestError } from "../../errors";
import { SuggestionStore } from "./SuggestionStore";

export class DeliveredButUnrecorded extends Error {}

function payload(message: Message, recipient: string, fromUser: boolean) {
  const sender =
    message.member?.displayName ?? message.author.globalName ?? message.author.username;
  return {
    content: null,
    embeds: [
      new EmbedBuilder()
        .setAuthor({
          name: `${sender} (@${message.author.username}) · ${fromUser ? "Member" : "Officer"}`,
          iconURL: message.author.displayAvatarURL(),
          url: `https://discord.com/users/${message.author.id}`,
        })
        .setDescription(message.content || "Attachment")
        .setFooter({ text: `To ${recipient}` }),
    ],
  };
}

export class SuggestionMessages {
  constructor(
    private readonly client: Client,
    private readonly store: SuggestionStore,
  ) {}

  private memberTransport(
    inbox: TextChannel,
    threadId: string,
    message: Message,
    webhookId?: string,
  ) {
    const ownerId = this.client.user?.id;
    if (!ownerId)
      return Effect.fail(new ConfigurationError({ message: "Discord application is not ready." }));
    return messageTransport({
      type: "webhook",
      channel: inbox,
      ownerId,
      name: "Sigil suggestions",
      reason: "Relay private suggestions with member identity",
      threadId,
      webhookId,
      identity: {
        username: `${message.author.globalName ?? message.author.username} (@${message.author.username})`,
        avatarURL: message.author.displayAvatarURL(),
      },
    });
  }

  private replyId = Effect.fn("SuggestionMessages.replyId")(function* (
    this: SuggestionMessages,
    message: Message,
    threadId: string,
    destinationId: string,
    sourceId?: string,
  ) {
    const referenced = message.reference?.messageId
      ? yield* this.store.getMessage(message.reference.messageId)
      : null;
    if (referenced?.threadId !== threadId) return;
    if (
      referenced.destinationChannelId === destinationId &&
      (sourceId === undefined || referenced.sourceChannelId === sourceId)
    )
      return referenced.destinationId;
    if (
      referenced.sourceChannelId === destinationId &&
      (sourceId === undefined || referenced.destinationChannelId === sourceId)
    )
      return referenced.sourceId;
  });

  private threadPayload = Effect.fn("SuggestionMessages.threadPayload")(function* (
    this: SuggestionMessages,
    message: Message,
    threadId: string,
    replyId?: string,
  ) {
    const embeds: EmbedBuilder[] = [];
    if (message.reference) {
      const quote = new EmbedBuilder().setDescription("Original message unavailable.");
      if (replyId) {
        const channel = yield* discordRequest(() => this.client.channels.fetch(threadId));
        if (!channel?.isThread())
          return yield* new ConfigurationError({
            message: "Suggestion reply thread is unavailable.",
          });
        const fetched = yield* Effect.result(discordRequest(() => channel.messages.fetch(replyId)));
        if (Result.isSuccess(fetched)) {
          const target = fetched.success;
          const sender =
            target.embeds[0]?.author?.name ??
            target.member?.displayName ??
            target.author.globalName ??
            target.author.username;
          quote
            .setAuthor({
              name: `Reply to ${sender}`.slice(0, 256),
              url: `https://discord.com/channels/${channel.guildId}/${threadId}/${replyId}`,
            })
            .setDescription(
              (target.content || target.embeds[0]?.description || "Attachment").slice(0, 500),
            );
        } else if (
          !(fetched.failure instanceof DiscordRequestError && fetched.failure.code === 10008)
        )
          return yield* fetched.failure;
      }
      embeds.push(quote);
    }
    return { embeds };
  });

  send = Effect.fn("SuggestionMessages.send")(function* (
    this: SuggestionMessages,
    message: Message,
    entry: { userId: string; threadId: string },
    destination: MessageChannel & { id: string },
    fromUser: boolean,
    inbox: TextChannel,
  ) {
    if (yield* this.store.getMessage(message.id)) return;
    const user = yield* discordRequest(() => this.client.users.fetch(entry.userId));
    const recipient = fromUser
      ? "officers"
      : `${user.globalName ?? user.username} (@${user.username})`;
    const replyId = yield* this.replyId(message, entry.threadId, destination.id, message.channelId);
    const transport = fromUser
      ? yield* this.memberTransport(inbox, entry.threadId, message)
      : yield* messageTransport({ type: "channel", channel: destination });
    const body = fromUser
      ? yield* this.threadPayload(message, entry.threadId, replyId)
      : payload(message, recipient, false);
    const sent = yield* transport.send({ source: message, ...body }, replyId);
    const webhookId = transport.webhookId;
    yield* this.store
      .linkMessage({
        threadId: entry.threadId,
        sourceId: message.id,
        sourceChannelId: message.channelId,
        authorId: message.author.id,
        destinationId: sent.id,
        destinationChannelId: destination.id,
        ...(webhookId ? { webhookId } : {}),
      })
      .pipe(
        Effect.mapError(
          () => new DeliveredButUnrecorded("Message delivered but link could not be saved"),
        ),
      );
  });

  edit = Effect.fn("SuggestionMessages.edit")(function* (
    this: SuggestionMessages,
    incoming: Message | PartialMessage,
    inbox: TextChannel,
  ) {
    const link = yield* this.store.getMessage(incoming.id);
    if (!link || link.sourceId !== incoming.id || link.sourceChannelId !== incoming.channelId)
      return;
    const message = incoming.partial ? yield* discordRequest(() => incoming.fetch()) : incoming;
    if (message.author.bot || message.webhookId || message.author.id !== link.authorId) return;
    if (link.webhookId) {
      const transport = yield* this.memberTransport(inbox, link.threadId, message, link.webhookId);
      const replyId = yield* this.replyId(message, link.threadId, link.threadId);
      const body = yield* this.threadPayload(message, link.threadId, replyId);
      yield* transport.edit(link.destinationId, { source: message, ...body });
      return;
    }
    const destination = yield* discordRequest(() =>
      this.client.channels.fetch(link.destinationChannelId),
    );
    if (!destination?.isTextBased() || !destination.isSendable())
      return yield* new ConfigurationError({
        message: "Suggestion message destination is unavailable.",
      });
    const entry = yield* this.store.getConversation(link.threadId);
    if (!entry) return;
    const user = yield* discordRequest(() => this.client.users.fetch(entry.userId));
    const fromUser = link.sourceChannelId !== link.threadId;
    const recipient = fromUser
      ? "officers"
      : `${user.globalName ?? user.username} (@${user.username})`;
    const transport = yield* messageTransport({ type: "channel", channel: destination });
    yield* transport.edit(link.destinationId, {
      source: message,
      ...payload(message, recipient, fromUser),
    });
  });
}
