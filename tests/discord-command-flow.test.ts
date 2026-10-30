import { expect, test } from "bun:test";
import {
  Client,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type Interaction,
} from "discord.js";
import { Effect } from "effect";
import { CommandRegistry, install } from "@autorole/discord-framework";
import { tryPromise } from "../src/effectful";

type CommandState = "fresh" | "deferred" | "replied" | "deferred-replied";

for (const state of ["fresh", "deferred", "replied", "deferred-replied"] satisfies CommandState[]) {
  test(`command failure is reported and responds after ${state}`, async () => {
    const client = new Client({ intents: [] });
    const delivered = Promise.withResolvers<void>();
    const replies: { method: string; payload: unknown }[] = [];
    const errors: string[] = [];
    const registry = new CommandRegistry([
      {
        definition: { name: "broken", toJSON: () => ({ name: "broken" }) },
        run: () => Effect.fail(new Error("private details")),
      },
    ]);
    const interaction = {
      commandName: "broken",
      isChatInputCommand: () => true,
      deferred: state === "deferred" || state === "deferred-replied",
      replied: state === "replied" || state === "deferred-replied",
      reply: async (payload: unknown) => {
        replies.push({ method: "reply", payload });
        delivered.resolve();
      },
      editReply: async (payload: unknown) => {
        replies.push({ method: "edit", payload });
        delivered.resolve();
      },
      followUp: async (payload: unknown) => {
        replies.push({ method: "followUp", payload });
        delivered.resolve();
      },
    } as unknown as Interaction;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* install(client, registry, [], (error) =>
              Effect.sync(() => {
                errors.push(error.message);
              }),
            );
            client.emit(Events.InteractionCreate, interaction);
            yield* tryPromise(() => delivered.promise);
          }),
        ),
      );
      expect(errors).toEqual(["private details"]);
      const content = "Something went wrong while running this command. Please try again.";
      expect(replies).toEqual([
        state === "deferred"
          ? { method: "edit", payload: content }
          : {
              method: state === "fresh" ? "reply" : "followUp",
              payload: { content, flags: MessageFlags.Ephemeral },
            },
      ]);
    } finally {
      await client.destroy();
    }
  });
}

test("runtime permission denial responds privately without running or logging as a failure", async () => {
  const client = new Client({ intents: [] });
  const delivered = Promise.withResolvers<void>();
  const errors: string[] = [];
  let ran = false;
  let reply: unknown;
  const registry = new CommandRegistry([
    {
      definition: { name: "admin", toJSON: () => ({ name: "admin" }) },
      permissions: {
        guildOnly: true,
        member: PermissionFlagsBits.ManageGuild,
        deniedMessage: "Manage Server required.",
      },
      run: () =>
        Effect.sync(() => {
          ran = true;
        }),
    },
  ]);
  const interaction = {
    commandName: "admin",
    isChatInputCommand: () => true,
    guildId: "guild",
    memberPermissions: new PermissionsBitField(0n),
    deferred: false,
    replied: false,
    reply: async (payload: unknown) => {
      reply = payload;
      delivered.resolve();
    },
  } as unknown as Interaction;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* install(client, registry, [], (error) =>
            Effect.sync(() => {
              errors.push(error.message);
            }),
          );
          client.emit(Events.InteractionCreate, interaction);
          yield* tryPromise(() => delivered.promise);
        }),
      ),
    );
    expect(ran).toBe(false);
    expect(errors).toEqual([]);
    expect(reply).toEqual({ content: "Manage Server required.", flags: MessageFlags.Ephemeral });
  } finally {
    await client.destroy();
  }
});

test("reporting failures to Discord preserves and reports the original error", async () => {
  const client = new Client({ intents: [] });
  const reported = Promise.withResolvers<void>();
  const errors: string[] = [];
  const registry = new CommandRegistry([
    {
      definition: { name: "broken", toJSON: () => ({ name: "broken" }) },
      run: () => {
        throw new Error("handler crashed");
      },
    },
  ]);
  const interaction = {
    commandName: "broken",
    isChatInputCommand: () => true,
    deferred: false,
    replied: false,
    reply: async () => {
      throw new Error("reply unavailable");
    },
  } as unknown as Interaction;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* install(client, registry, [], (error) =>
            Effect.sync(() => {
              errors.push(error.message);
              if (errors.length === 2) reported.resolve();
            }),
          );
          client.emit(Events.InteractionCreate, interaction);
          yield* tryPromise(() => reported.promise);
        }),
      ),
    );
    expect(errors).toEqual(["handler crashed", "reply unavailable"]);
  } finally {
    await client.destroy();
  }
});

test("unexpected Effect defects are reported and produce a generic reply", async () => {
  const client = new Client({ intents: [] });
  const delivered = Promise.withResolvers<void>();
  const errors: string[] = [];
  let reply: unknown;
  const registry = new CommandRegistry([
    {
      definition: { name: "broken", toJSON: () => ({ name: "broken" }) },
      run: () =>
        Effect.sync(() => {
          throw new Error("unexpected defect");
        }),
    },
  ]);
  const interaction = {
    commandName: "broken",
    isChatInputCommand: () => true,
    deferred: false,
    replied: false,
    reply: async (payload: unknown) => {
      reply = payload;
      delivered.resolve();
    },
  } as unknown as Interaction;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* install(client, registry, [], (error) =>
            Effect.sync(() => {
              errors.push(error.message);
            }),
          );
          client.emit(Events.InteractionCreate, interaction);
          yield* tryPromise(() => delivered.promise);
        }),
      ),
    );
    expect(errors).toEqual(["unexpected defect"]);
    expect(reply).toEqual({
      content: "Something went wrong while running this command. Please try again.",
      flags: MessageFlags.Ephemeral,
    });
  } finally {
    await client.destroy();
  }
});

test("interrupting a command does not send an error response", async () => {
  const client = new Client({ intents: [] });
  const started = Promise.withResolvers<void>();
  const errors: string[] = [];
  let replied = false;
  const registry = new CommandRegistry([
    {
      definition: { name: "waiting", toJSON: () => ({ name: "waiting" }) },
      run: () =>
        Effect.sync(() => {
          started.resolve();
        }).pipe(Effect.andThen(Effect.never)),
    },
  ]);
  const interaction = {
    commandName: "waiting",
    isChatInputCommand: () => true,
    deferred: false,
    replied: false,
    reply: async () => {
      replied = true;
    },
  } as unknown as Interaction;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* install(client, registry, [], (error) =>
            Effect.sync(() => {
              errors.push(error.message);
            }),
          );
          client.emit(Events.InteractionCreate, interaction);
          yield* tryPromise(() => started.promise);
        }),
      ),
    );
    expect(errors).toEqual([]);
    expect(replied).toBe(false);
  } finally {
    await client.destroy();
  }
});

test("autorole status denies missing permissions through its subcommand route", async () => {
  const { makeCommandRegistry } = await import("../src/bot/AutoroleCommands");
  const { RoleService } = await import("../src/bot/RoleService");
  const client = new Client({ intents: [] });
  const delivered = Promise.withResolvers<void>();
  let reply: unknown;
  let deferred = false;
  const errors: string[] = [];
  const interaction = {
    commandName: "autorole",
    isChatInputCommand: () => true,
    guildId: "guild",
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: { getSubcommand: () => "status", getSubcommandGroup: () => null },
    deferred: false,
    replied: false,
    deferReply: async () => {
      deferred = true;
    },
    reply: async (value: unknown) => {
      reply = value;
      delivered.resolve();
    },
  } as unknown as Interaction;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* install(client, makeCommandRegistry(new RoleService()), [], (error) =>
            Effect.sync(() => {
              errors.push(error.message);
            }),
          );
          client.emit(Events.InteractionCreate, interaction);
          yield* tryPromise(() => delivered.promise);
        }),
      ),
    );
    expect(deferred).toBe(false);
    expect(reply).toEqual({
      content: "You need Manage Server and Manage Roles to inspect autorole settings.",
      flags: MessageFlags.Ephemeral,
    });
    expect(errors).toEqual([]);
  } finally {
    await client.destroy();
  }
});
