import { expect, spyOn, test } from "bun:test";
import { ChannelType, Client, Collection, EmbedBuilder, Routes, type Attachment } from "discord.js";
import { Effect } from "effect";
import { messageTransport } from "@autorole/discord-framework";

const guildId = "100000000000000001";
const channelId = "100000000000000002";
const botId = "100000000000000003";
const webhookId = "100000000000000004";
const threadId = "100000000000000005";
const messageId = "100000000000000006";
const replyId = "100000000000000007";

for (const type of ["channel", "webhook"] as const) {
  test(`${type} transport serializes long text and clears old content and attachments on edit`, async () => {
    const client = new Client({ intents: [] });
    const user = { id: botId, username: "Bot", discriminator: "0", avatar: null, bot: true };
    const raw = {
      id: messageId,
      channel_id: type === "webhook" ? threadId : channelId,
      author: user,
      content: "",
      timestamp: "2026-11-16T00:00:00.000Z",
      attachments: [],
      embeds: [],
      type: 0,
    };
    const get = spyOn(client.rest, "get").mockImplementation(async (route) => {
      if (route === Routes.guild(guildId))
        return { id: guildId, name: "Test", features: [], roles: [] };
      if (route === Routes.channel(channelId))
        return type === "webhook"
          ? { id: channelId, guild_id: guildId, type: ChannelType.GuildText, name: "inbox" }
          : { id: channelId, type: ChannelType.DM, recipients: [user] };
      if (route === Routes.channelWebhooks(channelId)) return [];
      throw new Error(`Unexpected read: ${route}`);
    });
    const post = spyOn(client.rest, "post").mockImplementation(async (route) => {
      if (route === Routes.channelWebhooks(channelId))
        return {
          id: webhookId,
          type: 1,
          name: "Test relay",
          channel_id: channelId,
          guild_id: guildId,
          token: "fixture-token",
          user,
        };
      return raw;
    });
    const patch = spyOn(client.rest, "patch").mockResolvedValue(raw);
    try {
      await client.guilds.fetch(guildId);
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || !channel.isSendable())
        throw new Error("Missing message channel");
      const destination =
        type === "webhook" && channel.type === ChannelType.GuildText
          ? {
              type: "webhook" as const,
              channel,
              ownerId: botId,
              name: "Test relay",
              reason: "Test",
              threadId,
              identity: { username: "Member", avatarURL: "https://example.com/avatar.png" },
            }
          : { type: "channel" as const, channel };
      const transport = await Effect.runPromise(messageTransport(destination));
      const source = {
        content: "a".repeat(4000),
        attachments: new Collection<string, Attachment>(),
      };
      const quote = new EmbedBuilder().setDescription("Quoted text");
      const sent = await Effect.runPromise(transport.send({ source, embeds: [quote] }, replyId));
      expect(sent.id).toBe(messageId);
      expect(post.mock.calls.at(-1)?.[1]?.body).toMatchObject({
        embeds: [{ description: "Quoted text" }, { description: "a".repeat(4000) }],
        allowed_mentions: { parse: [], replied_user: false },
      });
      if (type === "channel")
        expect(post.mock.calls.at(-1)?.[1]?.body).toMatchObject({
          message_reference: { message_id: replyId, fail_if_not_exists: false },
        });
      else {
        expect(transport.webhookId).toBe(webhookId);
        expect(post.mock.calls.at(-1)?.[1]?.query?.get("thread_id")).toBe(threadId);
        expect(post.mock.calls.at(-1)?.[1]?.body).toMatchObject({
          username: "Member",
          avatar_url: "https://example.com/avatar.png",
        });
      }
      await Effect.runPromise(
        transport.edit(messageId, { source: { ...source, content: "Short" } }),
      );
      expect(patch.mock.calls.at(-1)?.[1]?.body).toMatchObject({
        content: "Short",
        embeds: [],
        attachments: [],
        allowed_mentions: { parse: [], replied_user: false },
      });
      await Effect.runPromise(
        transport.edit(messageId, { source, content: null, embeds: [quote] }),
      );
      expect(patch.mock.calls.at(-1)?.[1]?.body).toMatchObject({
        content: "",
        embeds: [{ description: "Quoted text" }],
        attachments: [],
      });
    } finally {
      get.mockRestore();
      post.mockRestore();
      patch.mockRestore();
      await client.destroy();
    }
  });
}
