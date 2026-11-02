import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type ButtonInteraction,
  type Client,
  type Message,
  type PartialMessage,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { Effect, Result, Semaphore } from "effect";
import { discordRequest } from "@autorole/discord-framework";
import { ConfigurationError, DiscordRequestError } from "../../errors";
import { logError } from "../../logger";
import { SuggestionMessages } from "./SuggestionMessages";
import { SuggestionStore } from "./SuggestionStore";
import { privateSuggestionOverwrites } from "./privacy";

export const suggestionGuildId = "1415400507006124093";
export const suggestionPanelChannelId = "1415400508578856993";
export const suggestionInboxChannelId = "1566116722790895726";
const officerCategoryId = "1566109875535355994";
const officerRoleId = "1564387083642998897";
export const suggestionOpenId = "suggestions:open";
const closePrefix = "suggestions:close:";
const conversationButtons = (threadId: string, open = true) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`suggestions:${open ? "close" : "reopen"}:${threadId}`)
      .setLabel(open ? "Close suggestion" : "Reopen suggestion")
      .setStyle(ButtonStyle.Secondary),
  );

export const suggestionPanel = {
  content: "Have a suggestion? Send it privately to the officers.",
  components: [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(suggestionOpenId)
        .setLabel("Send a suggestion")
        .setStyle(ButtonStyle.Primary),
    ),
  ],
  allowedMentions: { parse: [] as [] },
};

export class Suggestions {
  private constructor(
    private readonly client: Client,
    private readonly store: SuggestionStore,
    private readonly gate: Semaphore.Semaphore,
    private readonly messages = new SuggestionMessages(client, store),
  ) {}

  static make = Effect.fn("Suggestions.make")(function* (client: Client, path: string) {
    const store = yield* SuggestionStore.make(path);
    const gate = yield* Semaphore.make(1);
    return new Suggestions(client, store, gate);
  });

  interaction = Effect.fn("Suggestions.interaction")(function* (
    this: Suggestions,
    interaction: ButtonInteraction,
  ) {
    if (
      interaction.customId !== suggestionOpenId &&
      interaction.customId !== "suggestions:new" &&
      !/^suggestions:(?:close|reopen):\d{17,20}$/.test(interaction.customId)
    )
      return;
    if (
      (interaction.customId === suggestionOpenId || interaction.customId === "suggestions:new") &&
      interaction.guildId !== null &&
      (interaction.guildId !== suggestionGuildId ||
        interaction.channelId !== suggestionPanelChannelId)
    )
      return;
    if (
      interaction.customId !== suggestionOpenId &&
      interaction.guildId !== null &&
      interaction.guildId !== suggestionGuildId
    )
      return;
    yield* discordRequest(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }));
    const handled = interaction.customId.startsWith(closePrefix)
      ? this.close(interaction)
      : interaction.customId.startsWith("suggestions:reopen:")
        ? this.reopen(interaction)
        : this.open(interaction, interaction.customId === "suggestions:new");
    yield* this.gate
      .withPermit(handled)
      .pipe(
        Effect.catch((error) =>
          logError("suggestions_interaction_failed", { type: error.name }).pipe(
            Effect.andThen(
              discordRequest(() =>
                interaction.editReply(
                  "I couldn't complete that request. Please try again or contact an officer.",
                ),
              ).pipe(Effect.ignore),
            ),
          ),
        ),
      );
  });

  message = Effect.fn("Suggestions.message")(function* (
    this: Suggestions,
    incoming: Message | PartialMessage,
  ) {
    if (incoming.author?.bot || incoming.webhookId) return;
    if (
      incoming.channel.type !== ChannelType.DM &&
      (!incoming.guildId ||
        incoming.guildId !== suggestionGuildId ||
        !incoming.channel.isThread() ||
        incoming.channel.parentId !== suggestionInboxChannelId)
    )
      return;
    yield* this.gate.withPermit(this.relay(incoming)).pipe(
      Effect.catch((error) =>
        logError("suggestions_relay_failed", { type: error.name }).pipe(
          Effect.andThen(
            discordRequest(() =>
              incoming.reply({
                content: "I couldn't deliver that message. Please try again or contact an officer.",
                allowedMentions: { parse: [] },
              }),
            ).pipe(Effect.ignore),
          ),
        ),
      ),
    );
  });

  edited = Effect.fn("Suggestions.edited")(function* (
    this: Suggestions,
    incoming: Message | PartialMessage,
  ) {
    yield* this.gate
      .withPermit(
        Effect.gen({ self: this }, function* () {
          const link = yield* this.store.getMessage(incoming.id);
          if (!link || link.sourceId !== incoming.id || incoming.author?.bot || incoming.webhookId)
            return;
          const inbox = yield* this.inbox();
          yield* this.messages.edit(incoming, inbox);
        }),
      )
      .pipe(
        Effect.catch((error) =>
          logError("suggestions_edit_failed", { type: error.name }).pipe(
            Effect.andThen(
              discordRequest(() =>
                incoming.reply({
                  content: "I couldn't update the delivered message. Please contact an officer.",
                  allowedMentions: { parse: [] },
                }),
              ).pipe(Effect.ignore),
            ),
          ),
        ),
      );
  });

  private refreshControls = Effect.fn("Suggestions.refreshControls")(function* (
    this: Suggestions,
    threadId: string,
    open: boolean,
  ) {
    const controls = yield* this.store.getControls(threadId);
    for (const control of controls) {
      yield* discordRequest(async () => {
        const channel = await this.client.channels.fetch(control.channelId);
        if (channel?.isTextBased() && channel.isSendable())
          await channel.messages.edit(control.messageId, {
            components: [conversationButtons(threadId, open)],
          });
      }).pipe(
        Effect.catch((error) =>
          logError("suggestions_controls_update_failed", { type: error.name }),
        ),
      );
    }
  });

  private reopen = Effect.fn("Suggestions.reopen")(function* (
    this: Suggestions,
    interaction: ButtonInteraction,
  ) {
    const id = interaction.customId.slice("suggestions:reopen:".length);
    const entry = yield* this.store.getConversation(id);
    const isDm = interaction.guildId === null;
    const ownConversation = isDm || interaction.channelId === suggestionPanelChannelId;
    const permitted =
      entry &&
      (ownConversation
        ? entry.userId === interaction.user.id
        : interaction.channelId === id &&
          interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages));
    if (!permitted) {
      yield* discordRequest(() => interaction.editReply("You can't reopen this suggestion here."));
      return;
    }
    const active = yield* this.store.getByUser(entry.userId);
    if (active) {
      yield* discordRequest(() =>
        interaction.editReply(
          active.threadId === id
            ? "This suggestion is already open."
            : "Close the current suggestion before reopening another one.",
        ),
      );
      return;
    }
    const inbox = yield* this.inbox();
    const thread = yield* discordRequest(() => this.client.channels.fetch(id, { force: true }));
    if (!thread?.isThread() || thread.parentId !== inbox.id)
      return yield* new ConfigurationError({ message: "Suggestion thread is unavailable." });
    const user = yield* discordRequest(() => this.client.users.fetch(entry.userId));
    yield* discordRequest(async () => {
      await thread.setArchived(false, "Suggestion reopened");
    });
    const notice = yield* discordRequest(() =>
      thread.send({
        content: `Suggestion with <@${entry.userId}> reopened.`,
        components: [conversationButtons(id)],
        allowedMentions: { parse: [] },
      }),
    );
    yield* this.store.put(entry.userId, id);
    if (interaction.message && !interaction.message.flags.has(MessageFlags.Ephemeral))
      yield* this.store.trackControls(id, interaction.channelId, interaction.message.id);
    yield* this.store.trackControls(id, id, notice.id);
    yield* this.refreshControls(id, true);
    const confirmation = yield* Effect.result(
      discordRequest(() =>
        user.send({
          content:
            "Your conversation with the Gamers Hall officers is open again. Reply here to continue it.",
          components: [conversationButtons(id)],
        }),
      ),
    );
    if (Result.isSuccess(confirmation))
      yield* this.store.trackControls(id, confirmation.success.channelId, confirmation.success.id);
    yield* discordRequest(() =>
      interaction.editReply(
        Result.isFailure(confirmation)
          ? "Suggestion reopened, but I couldn't notify the member."
          : isDm || interaction.channelId === suggestionPanelChannelId
            ? "Suggestion reopened. Check your DMs to continue."
            : `Suggestion with <@${entry.userId}> reopened. Replies here will be sent to them.`,
      ),
    );
  });

  private inbox = Effect.fn("Suggestions.inbox")(function* (this: Suggestions) {
    const channel = yield* discordRequest(() =>
      this.client.channels.fetch(suggestionInboxChannelId, { force: true }),
    );
    if (
      !channel ||
      channel.type !== ChannelType.GuildText ||
      channel.guild.id !== suggestionGuildId ||
      channel.parentId !== officerCategoryId
    )
      return yield* new ConfigurationError({
        message: "Suggestion inbox is not configured in the Officers category.",
      });
    const parent = yield* discordRequest(() =>
      channel.guild.channels.fetch(officerCategoryId, { force: true }),
    );
    if (!parent || parent.type !== ChannelType.GuildCategory)
      return yield* new ConfigurationError({ message: "Officers category is missing." });
    yield* discordRequest(() => channel.guild.roles.fetch());
    const officerRole = channel.guild.roles.cache.get(officerRoleId);
    const validate = (candidate: TextChannel | typeof parent) =>
      privateSuggestionOverwrites(
        [...candidate.permissionOverwrites.cache.values()].map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: overwrite.allow.bitfield,
          deny: overwrite.deny.bitfield,
        })),
      );

    if (
      !validate(channel) ||
      !validate(parent) ||
      !officerRole ||
      !channel
        .permissionsFor(officerRole)
        ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads]) ||
      channel.guild.roles.everyone.permissions.has(PermissionFlagsBits.Administrator, false)
    )
      return yield* new ConfigurationError({
        message: "Suggestion inbox is not restricted to officers and advisors.",
      });
    return channel;
  });

  private open = Effect.fn("Suggestions.open")(function* (
    this: Suggestions,
    interaction: ButtonInteraction,
    fresh = false,
  ) {
    const inbox = yield* this.inbox();
    let existing = yield* this.store.getByUser(interaction.user.id);
    const dm = yield* discordRequest(() => interaction.user.createDM());
    if (existing) {
      const entry = existing;
      const fetched = yield* Effect.result(
        discordRequest(() => this.client.channels.fetch(entry.threadId, { force: true })),
      );
      if (
        Result.isFailure(fetched) &&
        !(fetched.failure instanceof DiscordRequestError && fetched.failure.code === 10003)
      )
        return yield* fetched.failure;
      const thread = Result.isSuccess(fetched) ? fetched.success : null;
      if (!thread) {
        yield* this.store.remove(entry.userId, entry.threadId);
        existing = null;
      } else if (!thread.isThread() || thread.parentId !== inbox.id) {
        return yield* new ConfigurationError({
          message: "Suggestion thread has an unexpected location.",
        });
      } else if (thread.archived) {
        yield* discordRequest(async () => {
          await thread.setArchived(false, "Continue suggestion");
        });
      }
    }
    if (existing) {
      const entry = existing;
      const confirmation = yield* discordRequest(() =>
        dm.send({
          content:
            "You're talking to the Gamers Hall officers. You already have an open suggestion. Reply here to continue it.",
          components: [conversationButtons(entry.threadId)],
        }),
      );
      yield* this.store.trackControls(entry.threadId, dm.id, confirmation.id);
      yield* discordRequest(() =>
        interaction.editReply("You already have an open suggestion. Check your DMs to continue."),
      );
      return;
    }
    if (!fresh) {
      const previous = yield* this.store.getPrevious(interaction.user.id);
      const recovered = yield* this.recover(inbox, interaction.user.id, previous?.threadId);
      if (recovered) {
        yield* this.store.remember(interaction.user.id, recovered.id);
        yield* discordRequest(() =>
          interaction.editReply({
            content: "Continue your previous suggestion or start a new one?",
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`suggestions:reopen:${recovered.id}`)
                  .setLabel("Continue previous suggestion")
                  .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                  .setCustomId("suggestions:new")
                  .setLabel("New suggestion")
                  .setStyle(ButtonStyle.Secondary),
              ),
            ],
          }),
        );
        return;
      }
    }
    const member = interaction.member;
    const nickname = member && ("nickname" in member ? member.nickname : member.nick);
    const username = interaction.user.username;
    const displayName = (nickname ?? interaction.user.globalName ?? username)
      .replace(/\s+/g, " ")
      .trim();
    const name = [...(displayName || username)].slice(0, 25).join("");
    const suffix = name.toLowerCase() === username.toLowerCase() ? "" : ` (@${username})`;
    const thread = yield* discordRequest(() =>
      inbox.threads.create({
        name: `Suggestion · ${name}${suffix}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        type: ChannelType.PublicThread,
        reason: "Open a suggestion for the officer team",
      }),
    );
    yield* Effect.gen({ self: this }, function* () {
      const starter = yield* discordRequest(() =>
        thread.send({
          content: `Suggestion from <@${interaction.user.id}> (\`${interaction.user.id}\`). Reply in this thread to message them.`,
          components: [conversationButtons(thread.id)],
          allowedMentions: { parse: [] },
        }),
      );
      const confirmation = yield* discordRequest(() =>
        dm.send({
          content:
            "You're talking to the Gamers Hall officers. Your conversation is open. Send your suggestion here; officers can reply in this DM. Use the button below when you're finished.",
          components: [conversationButtons(thread.id)],
        }),
      );
      yield* this.store.trackControls(thread.id, dm.id, confirmation.id);

      yield* this.store.put(interaction.user.id, thread.id);
      yield* this.store.trackControls(thread.id, thread.id, starter.id);
    }).pipe(
      Effect.onError(() =>
        this.store.remove(interaction.user.id, thread.id).pipe(
          Effect.ignore,
          Effect.andThen(
            discordRequest(async () => {
              await thread.delete("Suggestion setup failed");
            }).pipe(Effect.ignore),
          ),
        ),
      ),
    );
    yield* discordRequest(() =>
      interaction.editReply("Your suggestion conversation is open. Check your DMs."),
    );
  });

  private recover = Effect.fn("Suggestions.recover")(function* (
    this: Suggestions,
    inbox: TextChannel,
    userId: string,
    previousId?: string,
  ) {
    if (previousId) {
      const fetched = yield* Effect.result(
        discordRequest(() => this.client.channels.fetch(previousId, { force: true })),
      );
      if (Result.isFailure(fetched)) {
        if (!(fetched.failure instanceof DiscordRequestError && fetched.failure.code === 10003))
          return yield* fetched.failure;
      } else if (fetched.success) {
        const thread = fetched.success;
        if (!thread.isThread() || thread.parentId !== inbox.id)
          return yield* new ConfigurationError({
            message: "Suggestion thread has an unexpected location.",
          });
        return thread;
      }
    }
    const active = yield* discordRequest(() => inbox.threads.fetchActive());
    const candidates: ThreadChannel[] = [...active.threads.values()];
    let before: Date | undefined;
    while (true) {
      const page = yield* discordRequest(() =>
        inbox.threads.fetchArchived({ type: "public", limit: 100, before }),
      );
      candidates.push(...page.threads.values());
      if (!page.hasMore) break;
      const oldest = page.threads.last()?.archiveTimestamp;
      if (!oldest || (before && oldest >= before.getTime()))
        return yield* new ConfigurationError({
          message: "Could not inspect suggestion thread history.",
        });
      before = new Date(oldest);
    }
    candidates.sort((a, b) => (a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1));
    for (const thread of candidates) {
      if (thread.parentId !== inbox.id || thread.ownerId !== this.client.user?.id) continue;
      const messages = yield* discordRequest(() => thread.messages.fetch({ after: "0", limit: 1 }));
      const starter = messages.first();
      if (
        starter?.author.id !== this.client.user?.id ||
        !starter?.content.startsWith(`Suggestion from <@${userId}> (\`${userId}\`).`)
      )
        continue;
      if (yield* this.store.getByThread(thread.id)) continue;
      yield* this.store.trackControls(thread.id, thread.id, starter.id);
      return thread;
    }
    return null;
  });

  private relay = Effect.fn("Suggestions.relay")(function* (
    this: Suggestions,
    incoming: Message | PartialMessage,
  ) {
    const message = incoming.partial ? yield* discordRequest(() => incoming.fetch()) : incoming;
    if (
      !message.author ||
      message.author.bot ||
      message.webhookId ||
      (message.type !== MessageType.Default && message.type !== MessageType.Reply)
    )
      return;
    const fromUser = message.channel.type === ChannelType.DM;
    const entry = fromUser
      ? yield* this.store.getByUser(message.author.id)
      : yield* this.store.getByThread(message.channelId);
    if (!entry) {
      const closed = fromUser
        ? yield* this.store.getPrevious(message.author.id)
        : yield* this.store.getConversation(message.channelId);
      if (closed)
        yield* discordRequest(() =>
          message.reply({
            content:
              "This suggestion is closed. Reopen it before sending a message. Your message hasn't been delivered.",
            components: [conversationButtons(closed.threadId, false)],
            allowedMentions: { parse: [] },
          }),
        );
      return;
    }
    const referenced = message.reference?.messageId
      ? yield* this.store.getMessage(message.reference.messageId)
      : null;
    if (referenced && referenced.threadId !== entry.threadId) {
      yield* discordRequest(() =>
        message.reply({
          content:
            "That message belongs to another suggestion. Continue in the current conversation or close it before reopening the previous one. Your reply hasn't been delivered.",
          allowedMentions: { parse: [], repliedUser: false },
        }),
      );
      return;
    }
    if (!message.content.trim() && message.attachments.size === 0) {
      yield* discordRequest(() => message.reply("Please send text or an attachment."));
      return;
    }
    const inbox = yield* this.inbox();
    if (fromUser) {
      const thread = yield* discordRequest(() => this.client.channels.fetch(entry.threadId));
      if (!thread?.isThread() || thread.parentId !== inbox.id)
        return yield* new ConfigurationError({ message: "Suggestion thread is unavailable." });
      yield* this.messages.send(message, entry, thread, true, inbox);
    } else {
      const user = yield* discordRequest(() => this.client.users.fetch(entry.userId));
      const dm = yield* discordRequest(() => user.createDM());
      yield* this.messages.send(message, entry, dm, false, inbox);
    }
  });

  private close = Effect.fn("Suggestions.close")(function* (
    this: Suggestions,
    interaction: ButtonInteraction,
  ) {
    const isDm = interaction.guildId === null;
    if (!isDm && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      yield* discordRequest(() =>
        interaction.editReply("Only moderators can close a suggestion here."),
      );
      return;
    }
    const entry = isDm
      ? yield* this.store.getByUser(interaction.user.id)
      : yield* this.store.getByThread(interaction.channelId);
    if (!entry || interaction.customId !== `${closePrefix}${entry.threadId}`) {
      yield* discordRequest(() => interaction.editReply("This suggestion is already closed."));
      return;
    }
    const inbox = yield* this.inbox();
    const thread = yield* discordRequest(() => this.client.channels.fetch(entry.threadId));
    if (!thread?.isThread() || thread.parentId !== inbox.id)
      return yield* new ConfigurationError({ message: "Suggestion thread is unavailable." });
    if (interaction.message && !interaction.message.flags.has(MessageFlags.Ephemeral))
      yield* this.store.trackControls(
        entry.threadId,
        interaction.channelId,
        interaction.message.id,
      );
    const notice = yield* discordRequest(() =>
      thread.send({
        components: [conversationButtons(entry.threadId, false)],
        content: isDm ? "The member closed this suggestion." : "An officer closed this suggestion.",
      }),
    );
    yield* this.store.close(entry.userId, entry.threadId);
    yield* this.store.trackControls(entry.threadId, thread.id, notice.id);
    yield* this.refreshControls(entry.threadId, false);
    let notifyFailed = false;
    {
      const notification = yield* Effect.result(
        discordRequest(async () => {
          const user = await this.client.users.fetch(entry.userId);
          const sent = await user.send({
            content: "Your conversation with the Gamers Hall officers is closed.",
            components: [conversationButtons(entry.threadId, false)],
          });
          return sent;
        }),
      );
      notifyFailed = Result.isFailure(notification);
      if (Result.isSuccess(notification))
        yield* this.store.trackControls(
          entry.threadId,
          notification.success.channelId,
          notification.success.id,
        );
    }
    const archived = yield* Effect.result(
      discordRequest(async () => {
        await thread.setArchived(true, "Suggestion closed");
      }),
    );
    yield* discordRequest(() =>
      interaction.editReply(
        `Suggestion closed.${notifyFailed ? " I couldn't notify the member." : ""}${Result.isFailure(archived) ? " I couldn't archive the thread." : ""}`,
      ),
    );
  });
}
