import { expect, test } from "bun:test";
import {
  ChannelType,
  Collection,
  MessageType,
  MessageReferenceType,
  PermissionFlagsBits as F,
  PermissionsBitField,
  type ButtonInteraction,
  type Client,
  type Message,
} from "discord.js";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuggestionStore } from "../src/bot/suggestions/SuggestionStore";
import {
  Suggestions,
  suggestionGuildId,
  suggestionInboxChannelId,
  suggestionPanelChannelId,
} from "../src/bot/suggestions/Suggestions";

const userId = "100000000000000001";
const officerId = "100000000000000002";
const threadId = "100000000000000003";
const categoryId = "1566109875535355994";

function fixture() {
  const dms: unknown[] = [];
  const sentToThread: unknown[] = [];
  const edits: string[] = [];
  const reactions: string[] = [];
  const errors: string[] = [];
  const threadNames: string[] = [];
  const sourceMessages = new Map<string, Message>();
  let hookPresent = true;
  let hookCreations = 0;
  let denyWebhooks = false;
  const webhookEdits: unknown[] = [];
  let creations = 0;
  let messageSequence = 0;
  const deliveredEdits: { channelId: string; messageId: string; value: unknown }[] = [];
  const choices: unknown[] = [];
  const deliveredIds: string[] = [];
  const editMessage = (channelId: string) => async (messageId: string, value: unknown) => {
    deliveredEdits.push({ channelId, messageId, value });
  };
  let recoverable = false;
  let archived = false;
  let dmBlocked = false;
  let deleted = false;
  let threadAvailable = true;
  let failThreadSend = false;
  const everyone = {
    id: suggestionGuildId,
    type: 0,
    allow: new PermissionsBitField(0n),
    deny: new PermissionsBitField(F.ViewChannel),
  };
  const permissions = new Collection([[suggestionGuildId, everyone]]);
  const parent = { type: ChannelType.GuildCategory, permissionOverwrites: { cache: permissions } };
  const guild = {
    id: suggestionGuildId,
    channels: { fetch: async () => parent },
    roles: {
      fetch: async () => {},
      everyone: { permissions: new PermissionsBitField(0n) },
      cache: new Collection([["1564387083642998897", { id: "1564387083642998897" }]]),
    },
  };
  const thread = {
    id: threadId,
    parentId: suggestionInboxChannelId,
    ownerId: "bot",
    guildId: suggestionGuildId,
    isTextBased: () => true,
    isSendable: () => true,
    messages: {
      edit: editMessage(threadId),
      fetch: async (id: unknown) =>
        typeof id === "string"
          ? sourceMessages.get(id)
          : new Collection([
              [
                "starter",
                {
                  id: "starter",
                  author: { id: "bot" },
                  content: `Suggestion from <@${userId}> (\`${userId}\`). Reply in this thread to message them.`,
                },
              ],
            ]),
    },
    isThread: () => true,
    send: async (value: unknown) => {
      if (failThreadSend) throw new Error("thread send failed");
      sentToThread.push(value);
      const id = `thread-${++messageSequence}`;
      deliveredIds.push(id);
      return { id, channelId: threadId };
    },
    delete: async () => {
      deleted = true;
    },
    setArchived: async (value: boolean) => {
      archived = value;
    },
  };
  const hook = {
    id: "webhook",
    name: "Sigil suggestions",
    owner: { id: "bot" },
    channelId: suggestionInboxChannelId,
    token: "fixture-token",
    isIncoming: () => true,
    send: async (value: unknown) => thread.send(value),
    editMessage: async (id: string, value: unknown) => {
      webhookEdits.push(value);
      await editMessage(threadId)(id, value);
    },
  };
  const inbox = {
    id: suggestionInboxChannelId,
    type: ChannelType.GuildText,
    parentId: categoryId,
    guild,
    permissionOverwrites: { cache: permissions },
    permissionsFor: () => new PermissionsBitField(F.ViewChannel | F.SendMessagesInThreads),
    fetchWebhooks: async () => {
      if (denyWebhooks) throw new Error("Missing Manage Webhooks");
      return new Collection(hookPresent ? [[hook.id, hook]] : []);
    },
    createWebhook: async () => {
      hookCreations++;
      hookPresent = true;
      return hook;
    },
    threads: {
      fetchActive: async () => ({ threads: new Collection() }),
      fetchArchived: async () => ({
        threads: new Collection(recoverable ? [[threadId, thread]] : []),
        hasMore: false,
      }),
      create: async ({ name }: { name: string }) => {
        creations++;
        threadNames.push(name);
        threadAvailable = true;
        return thread;
      },
    },
  };
  const dm = {
    id: "dm",
    isTextBased: () => true,
    isSendable: () => true,
    messages: { edit: editMessage("dm") },
    send: async (value: unknown) => {
      if (dmBlocked) throw new Error("DMs closed");
      dms.push(value);
      const id = `dm-${++messageSequence}`;
      deliveredIds.push(id);
      return { id, channelId: "dm" };
    },
  };
  const user = {
    id: userId,
    username: "example_user",
    globalName: "Example",
    bot: false,
    displayAvatarURL: () => "https://cdn.discordapp.com/avatar.png",
    createDM: async () => dm,
    send: async (value: unknown) => dm.send(value),
  };
  const client = {
    user: { id: "bot" },
    channels: {
      fetch: async (id: string) =>
        id === suggestionInboxChannelId
          ? inbox
          : id === threadId && threadAvailable
            ? thread
            : id === "dm"
              ? dm
              : null,
    },
    users: { fetch: async () => user },
  } as unknown as Client;
  const interaction = (customId: string, dmChannel = false, moderator = true) =>
    ({
      customId,
      guildId: dmChannel ? null : suggestionGuildId,
      channelId: dmChannel
        ? "dm"
        : customId === "suggestions:open" || customId === "suggestions:new"
          ? suggestionPanelChannelId
          : threadId,
      user,
      member: { nickname: "Member Name" },
      memberPermissions: new PermissionsBitField(moderator ? F.ManageMessages : 0n),
      deferReply: async () => {},
      editReply: async (value: string | { content: string }) => {
        edits.push(typeof value === "string" ? value : value.content);
        if (typeof value !== "string") choices.push(value);
      },
    }) as unknown as ButtonInteraction;
  const message = (text: string, fromUser: boolean, attachments = new Collection()) => {
    const result = {
      id: `source-${++messageSequence}`,
      partial: false,
      type: MessageType.Default,
      author: fromUser
        ? user
        : {
            id: officerId,
            bot: false,
            username: "officer",
            globalName: "Officer Name",
            displayAvatarURL: () => "https://cdn.discordapp.com/officer.png",
          },
      webhookId: null,
      guildId: fromUser ? null : suggestionGuildId,
      channelId: fromUser ? "dm" : threadId,
      channel: fromUser
        ? { type: ChannelType.DM }
        : {
            type: ChannelType.PublicThread,
            parentId: suggestionInboxChannelId,
            isThread: () => true,
          },
      content: text,
      attachments,
      react: async (emoji: string) => {
        reactions.push(emoji);
      },
      reply: async (value: { content?: string } | string) => {
        errors.push(typeof value === "string" ? value : (value.content ?? ""));
      },
      embeds: [],
    } as unknown as Message;
    sourceMessages.set(result.id, result);
    return result;
  };
  return {
    client,
    webhookEdits,
    hookCreations: () => hookCreations,
    removeWebhook: () => {
      hookPresent = false;
    },
    denyWebhooks: () => {
      denyWebhooks = true;
    },
    recoverOldThread: () => {
      recoverable = true;
      archived = true;
    },
    interaction,
    message,
    permissions,
    dms,
    sentToThread,
    edits,
    reactions,
    errors,
    deliveredEdits,
    deliveredIds,
    choices,
    threadNames,
    creations: () => creations,
    archived: () => archived,
    deleted: () => deleted,
    blockDm: () => {
      dmBlocked = true;
    },
    removeThread: () => {
      threadAvailable = false;
    },
    failThreadSend: (value: boolean) => {
      failThreadSend = value;
    },
  };
}

// Disk-backed SQLite tests include filesystem syncs on shared CI runners.
const sqliteTestTimeout = 30_000;

test(
  "active and closed suggestion mappings persist across restart",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "suggestions-"));
    const path = join(dir, "data.sqlite");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SuggestionStore.make(path);
            yield* store.put(userId, threadId);
            expect(yield* store.getByUser(userId)).toEqual({ userId, threadId });
            expect(yield* store.getByThread(threadId)).toEqual({ userId, threadId });
            yield* Effect.flip(store.put(userId, "100000000000000004"));
          }),
        ),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SuggestionStore.make(path);
            expect(yield* store.getByUser(userId)).toEqual({ userId, threadId });
            yield* store.close(userId, threadId);
            expect(yield* store.getByUser(userId)).toBeNull();
            expect(yield* store.getByThread(threadId)).toBeNull();
          }),
        ),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SuggestionStore.make(path);
            expect(yield* store.getPrevious(userId)).toEqual({ userId, threadId });
            yield* store.put(userId, threadId);
            expect(yield* store.getByUser(userId)).toEqual({ userId, threadId });
          }),
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  sqliteTestTimeout,
);

test("button opens one private conversation, relays both ways, and closes it", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.creations()).toBe(1);
        expect(f.threadNames).toEqual(["Suggestion · Member Name (@example_user)"]);
        expect(f.dms).toHaveLength(1);
        expect(f.sentToThread).toHaveLength(1);
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.creations()).toBe(1);
        expect(f.dms).toHaveLength(2);
        const attachments = new Collection([
          ["one", { url: "https://cdn.discordapp.com/test.png", name: "test.png" }],
        ]);
        yield* service.message(f.message("my suggestion", true, attachments));
        expect(f.sentToThread[1]).toMatchObject({
          content: "my suggestion",
          files: [{ attachment: "https://cdn.discordapp.com/test.png", name: "test.png" }],
          allowedMentions: { parse: [] },
        });
        yield* service.message(f.message("Thanks for the idea", false));
        expect(f.dms.at(-1)).toMatchObject({
          embeds: [{ data: { description: "Thanks for the idea" } }],
          allowedMentions: { parse: [] },
        });
        expect(f.reactions).toEqual([]);
        yield* service.interaction(f.interaction(`suggestions:close:${threadId}`, false, false));
        expect(f.archived()).toBe(false);
        yield* service.interaction(f.interaction(`suggestions:close:${threadId}`));
        expect(f.archived()).toBe(true);
        const prior = f.sentToThread.length;
        yield* service.message(f.message("after close", true));
        expect(f.sentToThread).toHaveLength(prior);
      }),
    ),
  );
});

test("a public inbox prevents creation and closed DMs clean up the new thread", async () => {
  for (const mode of ["public", "blocked"] as const) {
    const f = fixture();
    if (mode === "public") f.permissions.clear();
    else f.blockDm();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Suggestions.make(f.client, ":memory:");
          yield* service.interaction(f.interaction("suggestions:open"));
          expect(f.creations()).toBe(mode === "public" ? 0 : 1);
          if (mode === "blocked") expect(f.deleted()).toBe(true);
          expect(f.edits.at(-1)).toContain("couldn't");
        }),
      ),
    );
  }
});

test("concurrent clicks create only one suggestion and stale buttons cannot close it", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* Effect.all(
          [
            service.interaction(f.interaction("suggestions:open")),
            service.interaction(f.interaction("suggestions:open")),
          ],
          { concurrency: "unbounded" },
        );
        expect(f.creations()).toBe(1);
        yield* service.interaction(f.interaction("suggestions:close:100000000000000004", true));
        expect(f.archived()).toBe(false);
        expect(f.edits.at(-1)).toContain("already closed");
        yield* service.message(f.message("still open", true));
        expect(f.sentToThread.at(-1)).toMatchObject({
          content: "still open",
        });
      }),
    ),
  );
});

test("suggestion access fails closed when a non-officer role can see the inbox", async () => {
  const f = fixture();
  f.permissions.set("100000000000000005", {
    id: "100000000000000005",
    type: 0,
    allow: new PermissionsBitField(F.ViewChannel),
    deny: new PermissionsBitField(0n),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.creations()).toBe(0);
        expect(f.dms).toHaveLength(0);
        expect(f.edits.at(-1)).toContain("couldn't");
      }),
    ),
  );
});

test("a deleted suggestion thread can be reopened without trapping the member", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        f.removeThread();
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.creations()).toBe(2);
        expect(f.edits.at(-1)).toContain("conversation is open");
      }),
    ),
  );
});

test("failed thread setup is cleaned up and a failed relay gives no delivery check", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        f.failThreadSend(true);
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.deleted()).toBe(true);
        expect(f.edits.at(-1)).toContain("couldn't");
        f.failThreadSend(false);
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.creations()).toBe(2);
        f.failThreadSend(true);
        yield* service.message(f.message("not delivered", true));
        expect(f.reactions).toEqual([]);
        expect(f.errors.at(-1)).toContain("couldn't deliver");
      }),
    ),
  );
});

test("closing and reopening reuses the original thread and resumes delivery", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        yield* service.interaction(f.interaction(`suggestions:close:${threadId}`, true));
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.edits.at(-1)).toContain("Continue your previous");
        yield* service.interaction(f.interaction(`suggestions:reopen:${threadId}`, true));
        expect(f.creations()).toBe(1);
        expect(f.archived()).toBe(false);
        yield* service.message(f.message("continued", true));
        expect(f.sentToThread.at(-1)).toMatchObject({
          content: "continued",
        });
        expect(f.reactions).toEqual([]);
      }),
    ),
  );
});

test("an archived legacy suggestion is recovered without creating another thread", async () => {
  const f = fixture();
  f.recoverOldThread();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.creations()).toBe(0);
        yield* service.interaction(f.interaction(`suggestions:reopen:${threadId}`, true));
        expect(f.archived()).toBe(false);
        yield* service.message(f.message("recovered", false));
        expect(f.dms.at(-1)).toMatchObject({ embeds: [{ data: { description: "recovered" } }] });
      }),
    ),
  );
});

test("relayed replies target the corresponding message in both directions and identify the sender", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        const original = f.message("A member message", true);
        yield* service.message(original);
        const copyId = f.deliveredIds.at(-1)!;
        expect(f.sentToThread.at(-1)).toMatchObject({
          content: "A member message",
          username: "Example (@example_user)",
          avatarURL: "https://cdn.discordapp.com/avatar.png",
          threadId,
          embeds: [],
          allowedMentions: { parse: [], repliedUser: false },
        });
        const reply = f.message("Officer reply", false);
        reply.reference = {
          messageId: copyId,
          channelId: threadId,
          guildId: suggestionGuildId,
          type: MessageReferenceType.Default,
        };
        yield* service.message(reply);
        const officerCopyId = f.deliveredIds.at(-1)!;
        expect(f.dms.at(-1)).toMatchObject({
          reply: { messageReference: original.id, failIfNotExists: false },
          embeds: [
            {
              data: {
                author: { name: "Officer Name (@officer) · Officer" },
                footer: { text: "To Example (@example_user)" },
              },
            },
          ],
          allowedMentions: { parse: [], repliedUser: false },
        });
        const followup = f.message("Member reply", true);
        followup.reference = {
          messageId: officerCopyId,
          channelId: "dm",
          guildId: undefined,
          type: MessageReferenceType.Default,
        };
        yield* service.message(followup);
        expect(f.sentToThread.at(-1)).toMatchObject({
          content: "Member reply",
          embeds: [
            {
              data: {
                author: {
                  name: "Reply to Officer Name",
                  url: `https://discord.com/channels/${suggestionGuildId}/${threadId}/${reply.id}`,
                },
                description: "Officer reply",
              },
            },
          ],
        });
        expect(f.sentToThread.at(-1)).not.toHaveProperty("reply");
      }),
    ),
  );
});

test(
  "message links survive restart and edits replace the delivered copy and attachments",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "suggestion-edits-"));
    const path = join(dir, "data.sqlite");
    const f = fixture();
    const original = f.message(
      "Original",
      true,
      new Collection([
        ["file", { url: "https://cdn.discordapp.com/original.png", name: "original.png" }],
      ]),
    );
    let copyId = "";
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Suggestions.make(f.client, path);
            yield* service.interaction(f.interaction("suggestions:open"));
            yield* service.message(original);
            copyId = f.deliveredIds.at(-1)!;
          }),
        ),
      );
      const count = f.sentToThread.length;
      original.content = "Edited";
      original.attachments.clear();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Suggestions.make(f.client, path);
            const partial = {
              ...original,
              partial: true,
              author: null,
              fetch: async () => original,
            } as unknown as Message;
            yield* service.edited(partial);
            expect(f.sentToThread).toHaveLength(count);
            expect(f.deliveredEdits.at(-1)).toMatchObject({
              channelId: threadId,
              messageId: copyId,
              value: {
                content: "Edited",
                attachments: [],
                files: [],
                embeds: [],
                threadId,
              },
            });
            const reply = f.message("After restart", false);
            reply.reference = {
              channelId: threadId,
              messageId: copyId,
              guildId: suggestionGuildId,
              type: MessageReferenceType.Default,
            };
            yield* service.message(reply);
            expect(f.dms.at(-1)).toMatchObject({ reply: { messageReference: original.id } });
            yield* service.edited(f.message("Unrelated", true));
            expect(f.deliveredEdits).toHaveLength(1);
          }),
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  sqliteTestTimeout,
);

test("closing refreshes controls and closed messages get a reopen action without delivery", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        yield* service.interaction(f.interaction(`suggestions:close:${threadId}`, true));
        expect(f.deliveredEdits.length).toBeGreaterThanOrEqual(2);
        for (const edit of f.deliveredEdits)
          expect(JSON.stringify(edit.value)).toContain(`suggestions:reopen:${threadId}`);
        const count = f.sentToThread.length;
        yield* service.message(f.message("Closed message", true));
        expect(f.sentToThread).toHaveLength(count);
        expect(f.errors.at(-1)).toContain("hasn't been delivered");
        yield* service.interaction(f.interaction(`suggestions:reopen:${threadId}`, false, false));
        expect(f.edits.at(-1)).toContain("can't reopen");
        yield* service.interaction(f.interaction(`suggestions:reopen:${threadId}`, false));
        expect(f.archived()).toBe(false);
        expect(f.edits.at(-1)).toContain("Replies here will be sent to them");
        expect(JSON.stringify(f.deliveredEdits.at(-1)?.value)).toContain(
          `suggestions:close:${threadId}`,
        );
      }),
    ),
  );
});

test("the new suggestion choice skips recovery", async () => {
  const f = fixture();
  f.recoverOldThread();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.dms).toHaveLength(0);
        expect(JSON.stringify(f.choices)).toContain("Continue previous suggestion");
        yield* service.interaction(f.interaction("suggestions:new"));
        expect(f.creations()).toBe(1);
        expect(f.dms).toHaveLength(1);
      }),
    ),
  );
});

test(
  "old replies cannot be delivered into a different active suggestion",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "suggestion-replies-"));
    const path = join(dir, "data.sqlite");
    const f = fixture();
    const oldThread = "100000000000000009";
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SuggestionStore.make(path);
            yield* store.remember(userId, oldThread);
            yield* store.put(userId, threadId);
            yield* store.linkMessage({
              threadId: oldThread,
              sourceId: "old-source",
              sourceChannelId: oldThread,
              authorId: officerId,
              destinationId: "old-copy",
              destinationChannelId: "dm",
            });
            const service = yield* Suggestions.make(f.client, path);
            const reply = f.message("Wrong conversation", true);
            reply.reference = {
              messageId: "old-copy",
              channelId: "dm",
              guildId: undefined,
              type: MessageReferenceType.Default,
            };
            yield* service.message(reply);
            expect(f.sentToThread).toHaveLength(0);
            expect(f.errors.at(-1)).toContain("another suggestion");
            yield* service.interaction(f.interaction(`suggestions:reopen:${oldThread}`, true));
            expect(f.edits.at(-1)).toContain("Close the current suggestion");
          }),
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  sqliteTestTimeout,
);

test("a different member cannot reopen a closed conversation", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        yield* service.interaction(f.interaction(`suggestions:close:${threadId}`, true));
        const unauthorized = f.interaction(`suggestions:reopen:${threadId}`, true);
        Object.defineProperty(unauthorized, "user", { value: { id: officerId } });
        yield* service.interaction(unauthorized);
        expect(f.archived()).toBe(true);
        expect(f.edits.at(-1)).toContain("can't reopen");
      }),
    ),
  );
});

test("the relay creates one webhook, reuses it, and ignores webhook messages", async () => {
  const f = fixture();
  f.removeWebhook();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        yield* service.message(f.message("One", true));
        yield* service.message(f.message("Two", true));
        expect(f.hookCreations()).toBe(1);
        const count = f.dms.length;
        const echo = f.message("Webhook echo", false);
        echo.webhookId = "webhook";
        yield* service.message(echo);
        expect(f.dms).toHaveLength(count);
        expect(f.sentToThread.at(-1)).toMatchObject({ content: "Two", threadId });
      }),
    ),
  );
});

test("missing webhook permissions report delivery failure without a bot-message fallback", async () => {
  const f = fixture();
  f.denyWebhooks();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        const count = f.sentToThread.length;
        yield* service.message(f.message("Cannot send", true));
        expect(f.sentToThread).toHaveLength(count);
        expect(f.errors.at(-1)).toContain("couldn't deliver");
      }),
    ),
  );
});

test("editing a message from a deleted webhook reports failure without creating another copy", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        const original = f.message("Before", true);
        yield* service.message(original);
        const count = f.sentToThread.length;
        f.removeWebhook();
        original.content = "After";
        yield* service.edited(original);
        expect(f.sentToThread).toHaveLength(count);
        expect(f.hookCreations()).toBe(0);
        expect(f.errors.at(-1)).toContain("couldn't update");
      }),
    ),
  );
});

test(
  "messages originally delivered by the bot still use bot edits",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "suggestion-bot-edits-"));
    const path = join(dir, "data.sqlite");
    const f = fixture();
    const original = f.message("Original bot delivery", true);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* SuggestionStore.make(path);
            yield* store.put(userId, threadId);
            yield* store.linkMessage({
              threadId,
              sourceId: original.id,
              sourceChannelId: "dm",
              authorId: userId,
              destinationId: "bot-copy",
              destinationChannelId: threadId,
            });
            const service = yield* Suggestions.make(f.client, path);
            original.content = "Edited legacy copy";
            yield* service.edited(original);
            expect(f.webhookEdits).toHaveLength(0);
            expect(f.deliveredEdits.at(-1)).toMatchObject({
              messageId: "bot-copy",
              value: { embeds: [{ data: { description: "Edited legacy copy" } }] },
            });
          }),
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  sqliteTestTimeout,
);
