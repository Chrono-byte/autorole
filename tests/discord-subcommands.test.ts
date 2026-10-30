import { expect, test } from "bun:test";
import { type ChatInputCommandInteraction } from "discord.js";
import { Effect, Result } from "effect";
import { CommandCatalog } from "../packages/discord/framework";
import { subcommands, UnknownSubcommandError } from "../packages/discord/subcommands";

const noop = () => Effect.void;

function interaction(subcommand: string | null, group: string | null = null) {
  return {
    commandName: "example",
    options: {
      getSubcommand: () => subcommand,
      getSubcommandGroup: () => group,
    },
  } as unknown as ChatInputCommandInteraction;
}

test("routes direct and grouped subcommands with their context", async () => {
  const seen: string[] = [];
  const router = subcommands<string>([
    {
      name: "status",
      run: (context) =>
        Effect.sync(() => {
          seen.push(`${context}:status`);
        }),
    },
    {
      group: "admin",
      name: "status",
      run: (context) =>
        Effect.sync(() => {
          seen.push(`${context}:admin-status`);
        }),
    },
    {
      group: "other",
      name: "status",
      run: (context) =>
        Effect.sync(() => {
          seen.push(`${context}:other-status`);
        }),
    },
  ]);
  await Effect.runPromise(router("ctx", interaction("status")));
  await Effect.runPromise(router("ctx", interaction("status", "admin")));
  await Effect.runPromise(router("ctx", interaction("status", "other")));
  expect(seen).toEqual(["ctx:status", "ctx:admin-status", "ctx:other-status"]);
});

test("rejects duplicate routes without conflating different groups", () => {
  const run = noop;
  expect(() =>
    subcommands([
      { name: "status", run },
      { name: "status", run },
    ]),
  ).toThrow("Duplicate subcommand route: status");
  expect(() =>
    subcommands([
      { group: "admin", name: "status", run },
      { group: "admin", name: "status", run },
    ]),
  ).toThrow("Duplicate subcommand route: admin status");
  expect(() =>
    subcommands([
      { name: "status", run },
      { group: "admin", name: "status", run },
    ]),
  ).not.toThrow();
});

test("unknown and missing routes fail in the Effect error channel", async () => {
  const router = subcommands([{ name: "status", run: () => Effect.void }]);
  for (const entry of [interaction("unknown"), interaction("status", "wrong"), interaction(null)]) {
    const result = await Effect.runPromise(Effect.result(router(undefined, entry)));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(UnknownSubcommandError);
      expect(result.failure.message).toContain("/example");
    }
  }
});

test("routes through a bound command catalog", async () => {
  const seen: string[] = [];
  const catalog = new CommandCatalog<string>([
    {
      definition: { name: "example", toJSON: () => ({ name: "example" }) },
      run: subcommands([
        {
          name: "status",
          run: (context) =>
            Effect.sync(() => {
              seen.push(context);
            }),
        },
      ]),
    },
  ]);
  await Effect.runPromise(catalog.bind("bound").dispatch(interaction("status")));
  expect(seen).toEqual(["bound"]);
});

test("subcommand permissions apply only to the selected route", async () => {
  const { PermissionFlagsBits, PermissionsBitField } = await import("discord.js");
  const { PermissionDenied } = await import("../packages/discord/permissions");
  const seen: string[] = [];
  const router = subcommands([
    {
      name: "view",
      run: () =>
        Effect.sync(() => {
          seen.push("view");
        }),
    },
    {
      name: "admin",
      permissions: { member: PermissionFlagsBits.ManageGuild },
      run: () =>
        Effect.sync(() => {
          seen.push("admin");
        }),
    },
  ]);
  const basic = interaction("view");
  await Effect.runPromise(router(undefined, basic));
  const denied = await Effect.runPromise(Effect.result(router(undefined, interaction("admin"))));
  expect(Result.isFailure(denied)).toBe(true);
  if (Result.isFailure(denied)) expect(denied.failure).toBeInstanceOf(PermissionDenied);
  const allowed = interaction("admin");
  Object.assign(allowed, {
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
  });
  await Effect.runPromise(router(undefined, allowed));
  expect(seen).toEqual(["view", "admin"]);
});
