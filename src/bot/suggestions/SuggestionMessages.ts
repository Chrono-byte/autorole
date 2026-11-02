import {
  EmbedBuilder,
  type Client,
  type Message,
  type PartialMessage,
  type MessageCreateOptions,
  type TextChannel,
} from "discord.js";
import { Effect, Result } from "effect";
import { discordRequest } from "@autorole/discord-framework";
import { ConfigurationError, DiscordRequestError } from "../../errors";
import { SuggestionStore } from "./SuggestionStore";

function files(message: Message) {
  return [...message.attachments.values()].map((attachment) => ({
    attachment: attachment.url,
    name: attachment.name ?? "attachment",
  }));
}

function payload(message: Message, recipient: string, fromUser: boolean) {
  const sender =
    message.member?.displayName ?? message.author.globalName ?? message.author.username;
  return {
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
    files: files(message),
    allowedMentions: { parse: [] as [], repliedUser: false },
  };
}

export class SuggestionMessages {
  constructor(
    private readonly client: Client,
    private readonly store: SuggestionStore,
  ) {}

  private webhook = Effect.fn("SuggestionMessages.webhook")(function* (
    this: SuggestionMessages,
    inbox: TextChannel,
    id?: string,
  ) {
    const hooks = yield* discordRequest(() => inbox.fetchWebhooks());
    const hook = hooks.find(
      (candidate) =>
        candidate.isIncoming() &&
        candidate.owner?.id === this.client.user?.id &&
        candidate.channelId === inbox.id &&
        (id ? candidate.id === id : candidate.name === "Sigil suggestions"),
    );
    if (hook?.isIncoming() && hook.token) return hook;
    if (id)
      return yield* new ConfigurationError({
        message: "The webhook for this suggestion message is unavailable.",
      });
    return yield* discordRequest(() =>
      inbox.createWebhook({
        name: "Sigil suggestions",
        reason: "Relay private suggestions with member identity",
      }),
    );
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
    return {
      content: message.content || null,
      embeds,
      files: files(message),
      allowedMentions: { parse: [] as [], repliedUser: false },
    };
  });

  send = Effect.fn("SuggestionMessages.send")(function* (
    this: SuggestionMessages,
    message: Message,
    entry: { userId: string; threadId: string },
    destination: { id: string; send: (options: MessageCreateOptions) => PromiseLike<Message> },
    fromUser: boolean,
    inbox: TextChannel,
  ) {
    if (yield* this.store.getMessage(message.id)) return;
    const user = yield* discordRequest(() => this.client.users.fetch(entry.userId));
    const recipient = fromUser
      ? "Gamers Hall officers"
      : `${user.globalName ?? user.username} (@${user.username})`;
    const linked = message.reference?.messageId
      ? yield* this.store.getMessage(message.reference.messageId)
      : null;
    const replyId =
      linked?.threadId === entry.threadId
        ? linked.sourceChannelId === message.channelId &&
          linked.destinationChannelId === destination.id
          ? linked.destinationId
          : linked.destinationChannelId === message.channelId &&
              linked.sourceChannelId === destination.id
            ? linked.sourceId
            : undefined
        : undefined;
    let webhookId: string | undefined;
    let sent: Message;
    if (fromUser) {
      const hook = yield* this.webhook(inbox);
      const body = yield* this.threadPayload(message, entry.threadId, replyId);
      sent = yield* discordRequest(() =>
        hook.send({
          ...body,
          content: body.content ?? undefined,
          threadId: entry.threadId,
          username:
            `${message.author.globalName ?? message.author.username} (@${message.author.username})`.slice(
              0,
              80,
            ),
          avatarURL: message.author.displayAvatarURL(),
        }),
      );
      webhookId = hook.id;
    } else {
      sent = yield* discordRequest(() =>
        destination.send({
          ...payload(message, recipient, false),
          ...(replyId ? { reply: { messageReference: replyId, failIfNotExists: false } } : {}),
        }),
      );
    }
    yield* this.store.linkMessage({
      threadId: entry.threadId,
      sourceId: message.id,
      sourceChannelId: message.channelId,
      authorId: message.author.id,
      destinationId: sent.id,
      destinationChannelId: destination.id,
      ...(webhookId ? { webhookId } : {}),
    });
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
      const hook = yield* this.webhook(inbox, link.webhookId);
      const referenced = message.reference?.messageId
        ? yield* this.store.getMessage(message.reference.messageId)
        : null;
      const replyId =
        referenced?.threadId === link.threadId
          ? referenced.destinationChannelId === link.threadId
            ? referenced.destinationId
            : referenced.sourceChannelId === link.threadId
              ? referenced.sourceId
              : undefined
          : undefined;
      const body = yield* this.threadPayload(message, link.threadId, replyId);
      yield* discordRequest(() =>
        hook.editMessage(link.destinationId, { ...body, attachments: [], threadId: link.threadId }),
      );
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
      ? "Gamers Hall officers"
      : `${user.globalName ?? user.username} (@${user.username})`;
    yield* discordRequest(() =>
      destination.messages.edit(link.destinationId, {
        ...payload(message, recipient, fromUser),
        content: null,
        attachments: [],
      }),
    );
  });
}
