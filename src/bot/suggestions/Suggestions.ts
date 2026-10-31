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
} from "discord.js";
import { Effect, Result, Semaphore } from "effect";
import { discordRequest, forwardMessage } from "@autorole/discord-framework";
import { ConfigurationError, DiscordRequestError } from "../../errors";
import { logError } from "../../logger";
import { SuggestionStore } from "./SuggestionStore";
import { privateSuggestionOverwrites } from "./privacy";

export const suggestionGuildId = "1415400507006124093";
export const suggestionPanelChannelId = "1415400508578856993";
export const suggestionInboxChannelId = "1566116722790895726";
const officerCategoryId = "1566109875535355994";
const officerRoleId = "1564387083642998897";
export const suggestionOpenId = "suggestions:open";
const closePrefix = "suggestions:close:";
const closeButton = (threadId: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${closePrefix}${threadId}`)
      .setLabel("Close suggestion")
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
      !/^suggestions:close:\d{17,20}$/.test(interaction.customId)
    )
      return;
    if (
      interaction.customId === suggestionOpenId &&
      (interaction.guildId !== suggestionGuildId ||
        interaction.channelId !== suggestionPanelChannelId)
    )
      return;
    if (
      interaction.customId.startsWith(closePrefix) &&
      interaction.guildId !== null &&
      interaction.guildId !== suggestionGuildId
    )
      return;
    yield* discordRequest(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }));
    const handled =
      interaction.customId === suggestionOpenId ? this.open(interaction) : this.close(interaction);
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
      }
    }
    if (existing) {
      const entry = existing;
      yield* discordRequest(() =>
        dm.send({
          content: "You already have an open suggestion. Reply here to continue it.",
          components: [closeButton(entry.threadId)],
        }),
      );
      yield* discordRequest(() =>
        interaction.editReply("You already have an open suggestion. Check your DMs to continue."),
      );
      return;
    }
    yield* discordRequest(() => dm.send("Opening a private conversation with the officers…"));
    const thread = yield* discordRequest(() =>
      inbox.threads.create({
        name: `suggestion-${interaction.user.id}`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        type: ChannelType.PublicThread,
        reason: "Open a suggestion for the officer team",
      }),
    );
    yield* Effect.gen({ self: this }, function* () {
      yield* discordRequest(() =>
        thread.send({
          content: `Suggestion from <@${interaction.user.id}> (\`${interaction.user.id}\`). Reply in this thread to message them. A ✅ reaction means your message was delivered.`,
          components: [closeButton(thread.id)],
          allowedMentions: { parse: [] },
        }),
      );
      yield* this.store.put(interaction.user.id, thread.id);
    }).pipe(
      Effect.onError(() =>
        discordRequest(async () => {
          await thread.delete("Suggestion setup failed");
        }).pipe(Effect.ignore),
      ),
    );
    yield* discordRequest(() =>
      dm.send({
        content:
          "Your conversation is open. Send your suggestion here; officers can reply in this DM. A ✅ reaction means your message was delivered. Use the button below when you're finished.",
        components: [closeButton(thread.id)],
      }),
    );
    yield* discordRequest(() =>
      interaction.editReply("Your suggestion conversation is open. Check your DMs."),
    );
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
    if (!entry) return;
    if (!message.content.trim() && message.attachments.size === 0) {
      yield* discordRequest(() => message.reply("Please send text or an attachment."));
      return;
    }
    const inbox = yield* this.inbox();
    if (fromUser) {
      const thread = yield* discordRequest(() => this.client.channels.fetch(entry.threadId));
      if (!thread?.isThread() || thread.parentId !== inbox.id)
        return yield* new ConfigurationError({ message: "Suggestion thread is unavailable." });
      yield* forwardMessage(message, thread);
    } else {
      const user = yield* discordRequest(() => this.client.users.fetch(entry.userId));
      const dm = yield* discordRequest(() => user.createDM());
      yield* forwardMessage(message, dm);
    }
    yield* discordRequest(() => message.react("✅")).pipe(Effect.ignore);
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
    yield* discordRequest(() =>
      thread.send({
        content: isDm ? "The member closed this suggestion." : "An officer closed this suggestion.",
      }),
    );
    yield* this.store.remove(entry.userId, entry.threadId);
    let notifyFailed = false;
    if (!isDm) {
      const notification = yield* Effect.result(
        discordRequest(async () => {
          const user = await this.client.users.fetch(entry.userId);
          await user.send(
            "Your suggestion conversation has been closed. You can start another from the server's suggestions channel.",
          );
        }),
      );
      notifyFailed = Result.isFailure(notification);
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
