import { expect, test } from "bun:test";
import {
  ChannelType,
  Collection,
  MessageType,
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
  let creations = 0;
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
    isThread: () => true,
    send: async (value: unknown) => {
      if (failThreadSend) throw new Error("thread send failed");
      sentToThread.push(value);
    },
    delete: async () => {
      deleted = true;
    },
    setArchived: async () => {
      archived = true;
    },
  };
  const inbox = {
    id: suggestionInboxChannelId,
    type: ChannelType.GuildText,
    parentId: categoryId,
    guild,
    permissionOverwrites: { cache: permissions },
    permissionsFor: () => new PermissionsBitField(F.ViewChannel | F.SendMessagesInThreads),
    threads: {
      create: async ({ name }: { name: string }) => {
        creations++;
        threadNames.push(name);
        threadAvailable = true;
        return thread;
      },
    },
  };
  const dm = {
    send: async (value: unknown) => {
      if (dmBlocked) throw new Error("DMs closed");
      dms.push(value);
    },
  };
  const user = {
    id: userId,
    username: "example_user",
    globalName: "Example",
    bot: false,
    createDM: async () => dm,
    send: async (value: unknown) => dm.send(value),
  };
  const client = {
    channels: {
      fetch: async (id: string) =>
        id === suggestionInboxChannelId
          ? inbox
          : id === threadId && threadAvailable
            ? thread
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
        : customId === "suggestions:open"
          ? suggestionPanelChannelId
          : threadId,
      user,
      member: { nickname: "Member Name" },
      memberPermissions: new PermissionsBitField(moderator ? F.ManageMessages : 0n),
      deferReply: async () => {},
      editReply: async (text: string) => {
        edits.push(text);
      },
    }) as unknown as ButtonInteraction;
  const message = (text: string, fromUser: boolean, attachments = new Collection()) =>
    ({
      partial: false,
      type: MessageType.Default,
      author: fromUser ? user : { id: officerId, bot: false },
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
    }) as unknown as Message;
  return {
    client,
    interaction,
    message,
    permissions,
    dms,
    sentToThread,
    edits,
    reactions,
    errors,
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

test("suggestion mappings persist across restart and permit a fresh case after closing", async () => {
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
          yield* store.remove(userId, threadId);
          expect(yield* store.getByUser(userId)).toBeNull();
          yield* store.put(userId, "100000000000000004");
        }),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("button opens one private conversation, relays both ways, and closes it", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Suggestions.make(f.client, ":memory:");
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.creations()).toBe(1);
        expect(f.threadNames).toEqual(["Suggestion · Member Name (@example_user)"]);
        expect(f.dms).toHaveLength(2);
        expect(f.sentToThread).toHaveLength(1);
        yield* service.interaction(f.interaction("suggestions:open"));
        expect(f.creations()).toBe(1);
        expect(f.dms).toHaveLength(3);
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
          content: "Thanks for the idea",
          allowedMentions: { parse: [] },
        });
        expect(f.reactions).toEqual(["✅", "✅"]);
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

test("a public inbox and closed DMs do not create a thread", async () => {
  for (const mode of ["public", "blocked"] as const) {
    const f = fixture();
    if (mode === "public") f.permissions.clear();
    else f.blockDm();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Suggestions.make(f.client, ":memory:");
          yield* service.interaction(f.interaction("suggestions:open"));
          expect(f.creations()).toBe(0);
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
        expect(f.sentToThread.at(-1)).toMatchObject({ content: "still open" });
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
