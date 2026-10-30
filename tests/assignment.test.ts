import { expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  Client,
  Events,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  PermissionsBitField,
  Routes,
  type ApplicationCommandPermissions,
} from "discord.js";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { tryPromise } from "../src/effectful";
import { OutstandingAssignments } from "../src/bot/OutstandingAssignments";
import { readConfiguration } from "../src/config/Configuration";
import { RoleService } from "../src/bot/RoleService";
import { commandDefinitions, makeCommandRegistry } from "../src/bot/AutoroleCommands";
import { makeAutorole } from "../src/bot/module";
import { install } from "../packages/discord/framework";

const ids = {
  app: "100000000000000001",
  guild: "100000000000000002",
  member: "100000000000000003",
  botRole: "100000000000000004",
  target: "100000000000000005",
  command: "100000000000000006",
  replacement: "100000000000000007",
};

class DiscordFixture {
  readonly client = new Client({ intents: [] });
  permissions: ApplicationCommandPermissions[] = [{ id: ids.target, type: 1, permission: true }];
  appPermissions: ApplicationCommandPermissions[] = [];
  includeOverrides = true;
  permissionRequestFails = false;
  memberLeft = false;
  permissionError = new Error("Discord permissions unavailable");
  manageRoles = true;
  targetPosition = 1;
  pending = false;
  omitPending = false;
  memberReadGate: Promise<void> | undefined;
  onMemberRead: (() => void) | undefined;
  memberReads = 0;
  bot = false;
  existingRoles: string[] = [];
  readonly writes: string[] = [];
  onRoleWrite?: () => void;
  private readonly get = spyOn(this.client.rest, "get").mockImplementation(async (route) => {
    if (route === Routes.guild(ids.guild)) {
      return {
        id: ids.guild,
        name: "Test server",
        unavailable: false,
        owner_id: "100000000000000099",
        features: [],
        roles: [
          { id: ids.guild, name: "@everyone", position: 0, permissions: "0" },
          {
            id: ids.botRole,
            name: "Bot",
            position: 10,
            permissions: this.manageRoles ? PermissionFlagsBits.ManageRoles.toString() : "0",
          },
          { id: ids.target, name: "Member", position: this.targetPosition, permissions: "0" },
          { id: ids.replacement, name: "Replacement", position: 2, permissions: "0" },
        ],
      };
    }
    if (
      route === Routes.applicationGuildCommands(ids.app, ids.guild) ||
      route === Routes.applicationCommands(ids.app)
    ) {
      return [
        {
          ...commandDefinitions
            .find((definition) => definition.name === "autorole-target")
            ?.toJSON(),
          id: ids.command,
          application_id: ids.app,
          version: ids.command,
        },
      ];
    }
    if (route === Routes.guildApplicationCommandsPermissions(ids.app, ids.guild)) {
      if (this.permissionRequestFails) throw this.permissionError;
      return [
        {
          id: ids.app,
          application_id: ids.app,
          guild_id: ids.guild,
          permissions: this.appPermissions,
        },
        ...(this.includeOverrides
          ? [
              {
                id: ids.command,
                application_id: ids.app,
                guild_id: ids.guild,
                permissions: this.permissions,
              },
            ]
          : []),
      ];
    }
    if (route === Routes.guildMember(ids.guild, ids.member)) {
      this.memberReads++;
      const capturedPending = this.pending;
      this.onMemberRead?.();
      await this.memberReadGate;
      if (this.memberLeft)
        throw new DiscordAPIError(
          { message: "Unknown Member", code: 10007 },
          10007,
          404,
          "GET",
          "https://discord.com",
          {},
        );
      return {
        user: {
          id: ids.member,
          username: "Member",
          discriminator: "0",
          avatar: null,
          bot: this.bot,
        },
        roles: this.existingRoles,
        ...(this.omitPending ? {} : { pending: capturedPending }),
        joined_at: "2026-01-01T00:00:00.000Z",
      };
    }
    if (route === Routes.guildMember(ids.guild, ids.app)) {
      return {
        user: { id: ids.app, username: "Autorole", discriminator: "0", avatar: null, bot: true },
        roles: [ids.botRole],
        joined_at: "2026-01-01T00:00:00.000Z",
      };
    }
    throw new Error(`Unexpected Discord read: ${route}`);
  });
  private readonly put = spyOn(this.client.rest, "put").mockImplementation(async (route) => {
    this.writes.push(route);
    this.onRoleWrite?.();
    return undefined;
  });

  constructor(readonly global = false) {
    const require = createRequire(import.meta.url);
    const ready: unknown = require(
      join(dirname(require.resolve("discord.js")), "client/websocket/handlers/READY.js"),
    );
    if (typeof ready !== "function") throw new Error("Discord READY handler is unavailable");
    ready(
      this.client,
      {
        d: {
          user: { id: ids.app, username: "Autorole", discriminator: "0", avatar: null, bot: true },
          application: { id: ids.app, flags: 0 },
          guilds: [],
        },
      },
      { id: 0, checkReady() {} },
    );
  }

  async setup() {
    const config = Effect.runSync(
      readConfiguration({
        DISCORD_TOKEN: "fixture",
        DISCORD_APPLICATION_ID: ids.app,
        ...(this.global ? {} : { DISCORD_GUILD_ID: ids.guild }),
      }),
    );
    const guild = await this.client.guilds.fetch({ guild: ids.guild, force: true });
    const member = await guild.members.fetch({ user: ids.member, force: true });
    return { member, roles: new RoleService(config.guildId) };
  }

  async assign() {
    const { member, roles } = await this.setup();
    await Effect.runPromise(roles.assign(member));
  }

  async close() {
    this.get.mockRestore();
    this.put.mockRestore();
    await this.client.destroy();
  }
}

async function withDiscord(run: (fixture: DiscordFixture) => Promise<void>, global = false) {
  const fixture = new DiscordFixture(global);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

test("Discord command permissions flow through real managers to a role PUT", async () => {
  await withDiscord(async (fixture) => {
    await fixture.assign();
    expect(fixture.writes).toEqual([Routes.guildMemberRole(ids.guild, ids.member, ids.target)]);
  });
});

test("global command registration uses the same per-server configuration", async () => {
  await withDiscord(async (fixture) => {
    await fixture.assign();
    expect(fixture.writes).toEqual([Routes.guildMemberRole(ids.guild, ids.member, ids.target)]);
  }, true);
});

test("changing and removing Integrations selections changes future assignments", async () => {
  await withDiscord(async (fixture) => {
    await fixture.assign();
    fixture.permissions = [{ id: ids.replacement, type: 1, permission: true }];
    await fixture.assign();
    fixture.permissions = [];
    await fixture.assign();
    expect(fixture.writes).toEqual([
      Routes.guildMemberRole(ids.guild, ids.member, ids.target),
      Routes.guildMemberRole(ids.guild, ids.member, ids.replacement),
    ]);
  });
});

test("app-wide access permissions never become an autorole", async () => {
  await withDiscord(async (fixture) => {
    fixture.includeOverrides = false;
    fixture.appPermissions = [{ id: ids.target, type: 1, permission: true }];
    await fixture.assign();
    expect(fixture.writes).toEqual([]);
  });
});

test("ambiguous selections and API failures never assign a role", async () => {
  await withDiscord(async (fixture) => {
    fixture.permissions.push({ id: ids.replacement, type: 1, permission: true });
    await expect(fixture.assign()).rejects.toThrow("exactly one role");
    fixture.permissionRequestFails = true;
    await expect(fixture.assign()).rejects.toThrow("permissions unavailable");
    expect(fixture.writes).toEqual([]);
  });
});

test("screening completion permits assignment; bots and existing roles are skipped", async () => {
  await withDiscord(async (fixture) => {
    fixture.pending = true;
    await fixture.assign();
    expect(fixture.writes).toEqual([]);
    fixture.pending = false;
    await fixture.assign();
    expect(fixture.writes).toHaveLength(1);
    fixture.bot = true;
    await fixture.assign();
    fixture.bot = false;
    fixture.existingRoles = [ids.target];
    await fixture.assign();
    expect(fixture.writes).toHaveLength(1);
  });
});

test("missing Manage Roles and insufficient hierarchy prevent role assignment", async () => {
  await withDiscord(async (fixture) => {
    fixture.manageRoles = false;
    await expect(fixture.assign()).rejects.toThrow("Manage Roles");
    fixture.manageRoles = true;
    fixture.targetPosition = 20;
    await expect(fixture.assign()).rejects.toThrow("highest role above");
    expect(fixture.writes).toEqual([]);
  });
});

test("command definitions serialize without constructing runtime dependencies", () => {
  expect(commandDefinitions.map((definition) => definition.toJSON().name)).toEqual([
    "autorole",
    "autorole-target",
  ]);
  expect(
    commandDefinitions.find((definition) => definition.name === "autorole-target")?.toJSON(),
  ).toMatchObject({
    name: "autorole-target",
    default_member_permissions: "0",
  });
});

test("permission interpretation ignores everyone, users, channels and denied roles", async () => {
  await withDiscord(async (fixture) => {
    fixture.permissions = [
      { id: ids.guild, type: 1, permission: true },
      { id: ids.target, type: 1, permission: false },
      { id: ids.member, type: 2, permission: true },
      { id: ids.guild, type: 3, permission: true },
    ];
    await fixture.assign();
    expect(fixture.writes).toEqual([]);
  });
});

test("denying the configured role disables assignment", async () => {
  await withDiscord(async (fixture) => {
    fixture.permissions = [{ id: ids.target, type: 1, permission: false }];
    await fixture.assign();
    expect(fixture.writes).toEqual([]);
  });
});

test("status resolves the same validated role without assigning it", async () => {
  await withDiscord(async (fixture) => {
    const config = Effect.runSync(
      readConfiguration({
        DISCORD_TOKEN: "fixture",
        DISCORD_APPLICATION_ID: ids.app,
        DISCORD_GUILD_ID: ids.guild,
      }),
    );
    const roles = new RoleService(config.guildId);
    const guild = await fixture.client.guilds.fetch(ids.guild);
    expect((await Effect.runPromise(roles.getConfiguredRole(guild)))?.id).toBe(ids.target);
    fixture.permissions = [];
    expect(await Effect.runPromise(roles.getConfiguredRole(guild))).toBeNull();
    fixture.permissions = [{ id: ids.target, type: 1, permission: true }];
    fixture.permissionRequestFails = true;
    await expect(Effect.runPromise(roles.getConfiguredRole(guild))).rejects.toThrow(
      "permissions unavailable",
    );
    expect(fixture.writes).toEqual([]);
  });
});

test("screening recovery honors its persisted deadline and current target after restart", async () => {
  await withDiscord(async (fixture) => {
    fixture.pending = true;
    const { member, roles } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    const path = `/tmp/autorole-test-${crypto.randomUUID()}.sqlite`;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(0);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const first = yield* OutstandingAssignments.make(
                path,
                fixture.client,
                roles,
                () => Effect.void,
              );
              yield* first.observeJoin(member);
            }),
          );
          expect(fixture.writes).toEqual([]);
          fixture.pending = false;
          fixture.permissions = [{ id: ids.replacement, type: 1, permission: true }];
          yield* TestClock.adjust(5 * 60_000 - 1);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const second = yield* OutstandingAssignments.make(
                path,
                fixture.client,
                roles,
                () => Effect.void,
              );
              yield* second.reconcile();
              expect(fixture.writes).toEqual([]);
              yield* TestClock.adjust(1);
              yield* second.reconcile();
            }),
          );
          expect(fixture.writes).toEqual([
            Routes.guildMemberRole(ids.guild, ids.member, ids.replacement),
          ]);
        }).pipe(Effect.provide(TestClock.layer())),
      );
    } finally {
      await Bun.file(path).delete();
    }
  });
});

test("untracked members are never assigned on availability", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* OutstandingAssignments.make(
            ":memory:",
            fixture.client,
            roles,
            () => Effect.void,
          );
          yield* tracker.observe(member);
          yield* tracker.reconcile();
        }),
      ),
    );
    expect(fixture.writes).toEqual([]);
  });
});

test("screening completion during a member fetch triggers another check", async () => {
  await withDiscord(async (fixture) => {
    fixture.pending = true;
    const { member, roles } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    let release: (() => void) | undefined;
    const readStarted = Promise.withResolvers<void>();
    fixture.onMemberRead = () => readStarted.resolve();
    fixture.pending = true;
    fixture.memberReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* OutstandingAssignments.make(
            ":memory:",
            fixture.client,
            roles,
            () => Effect.void,
          );
          const joinFiber = yield* Effect.forkChild(tracker.observeJoin(member));
          yield* tryPromise(() => readStarted.promise);
          fixture.pending = false;
          member.pending = false;
          yield* tracker.observe(member);
          release?.();
          yield* Fiber.join(joinFiber);
        }),
      ),
    );
    expect(fixture.writes).toEqual([Routes.guildMemberRole(ids.guild, ids.member, ids.target)]);
  });
});

test("persisted gateway screening evidence survives an omitted REST field and restart", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    const path = `/tmp/autorole-evidence-${crypto.randomUUID()}.sqlite`;
    let release: (() => void) | undefined;
    const readStarted = Promise.withResolvers<void>();
    fixture.onMemberRead = () => readStarted.resolve();
    fixture.memberReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* OutstandingAssignments.make(
            path,
            fixture.client,
            roles,
            () => Effect.void,
          );
          const joinFiber = yield* Effect.forkChild(first.observeJoin(member));
          yield* tryPromise(() => readStarted.promise);
          yield* first.stop();
          release?.();
          yield* Fiber.join(joinFiber);
        }),
      ),
    );
    fixture.memberReadGate = undefined;
    fixture.omitPending = true;
    member.guild.members.cache.delete(member.id);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const second = yield* OutstandingAssignments.make(
            path,
            fixture.client,
            roles,
            () => Effect.void,
          );
          yield* second.reconcile();
        }),
      ),
    );
    expect(fixture.writes).toEqual([Routes.guildMemberRole(ids.guild, ids.member, ids.target)]);
    await Bun.file(path).delete();
  });
});

test("interruption discards a queued recheck without waiting for Discord", async () => {
  await withDiscord(async (fixture) => {
    fixture.pending = true;
    const { member, roles } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    const gate = Promise.withResolvers<void>();
    fixture.memberReadGate = gate.promise;
    const readStarted = Promise.withResolvers<void>();
    fixture.onMemberRead = () => readStarted.resolve();
    let rescued = false;
    const rescue = setTimeout(() => {
      rescued = true;
      gate.resolve();
    }, 100);
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const tracker = yield* OutstandingAssignments.make(
              ":memory:",
              fixture.client,
              roles,
              () => Effect.void,
            );
            const job = yield* Effect.forkChild(tracker.observeJoin(member));
            yield* tryPromise(() => readStarted.promise);
            yield* tracker.observe(member);
            yield* Fiber.interrupt(job);
            expect(rescued).toBe(false);
          }),
        ),
      );
    } finally {
      clearTimeout(rescue);
      gate.resolve();
    }
    expect(fixture.writes).toEqual([]);
  });
});

test("transient Discord failures back off to one hour and recover without duplicate assignment", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    fixture.permissionRequestFails = true;
    fixture.permissionError = new HTTPError(503, "Unavailable", "GET", "https://discord.com", {});
    let failures = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(0);
          const tracker = yield* OutstandingAssignments.make(
            ":memory:",
            fixture.client,
            roles,
            () =>
              Effect.sync(() => {
                failures++;
              }),
          );
          yield* tracker.observeJoin(member);
          expect(failures).toBe(1);
          for (const minutes of [1, 2, 4, 8, 16, 32, 60, 60]) {
            const previous = failures;
            yield* TestClock.adjust(minutes * 60_000 - 1);
            yield* tracker.reconcile();
            expect(failures).toBe(previous);
            yield* TestClock.adjust(1);
            yield* tracker.reconcile();
            expect(failures).toBe(previous + 1);
          }
          fixture.permissionRequestFails = false;
          yield* TestClock.adjust(60 * 60_000);
          yield* tracker.reconcile();
          expect(fixture.writes).toHaveLength(1);
          const reads = fixture.memberReads;
          yield* TestClock.adjust(60 * 60_000);
          yield* tracker.reconcile();
          expect(fixture.memberReads).toBe(reads);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
});

for (const failure of ["configuration", "permission", "disabled"]) {
  test(`${failure} retains the assignment and rechecks in five minutes`, async () => {
    await withDiscord(async (fixture) => {
      const { member, roles } = await fixture.setup();
      member.guild.available = true;
      fixture.client.guilds.cache.set(member.guild.id, member.guild);
      if (failure === "configuration")
        fixture.permissions.push({ id: ids.replacement, type: 1, permission: true });
      if (failure === "permission") {
        fixture.permissionRequestFails = true;
        fixture.permissionError = new DiscordAPIError(
          { message: "Missing Permissions", code: 50013 },
          50013,
          403,
          "GET",
          "https://discord.com",
          {},
        );
      }
      if (failure === "disabled") fixture.permissions = [];
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(0);
            const tracker = yield* OutstandingAssignments.make(
              ":memory:",
              fixture.client,
              roles,
              () => Effect.void,
            );
            yield* tracker.observeJoin(member);
            expect(fixture.writes).toEqual([]);
            fixture.manageRoles = true;
            fixture.permissionRequestFails = false;
            fixture.permissions = [{ id: ids.target, type: 1, permission: true }];
            yield* TestClock.adjust(5 * 60_000 - 1);
            yield* tracker.reconcile();
            expect(fixture.writes).toEqual([]);
            yield* TestClock.adjust(1);
            yield* tracker.reconcile();
            expect(fixture.writes).toHaveLength(1);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
    });
  });
}

test("a departed member is removed instead of retried", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    fixture.memberLeft = true;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* OutstandingAssignments.make(
            ":memory:",
            fixture.client,
            roles,
            () => Effect.void,
          );
          yield* tracker.observeJoin(member);
          const reads = fixture.memberReads;
          yield* TestClock.adjust(60 * 60_000);
          yield* tracker.reconcile();
          expect(fixture.memberReads).toBe(reads);
          expect(fixture.writes).toEqual([]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
});

test("background reconciliation follows the test clock and stops with its fiber", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    fixture.permissions = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(0);
          const tracker = yield* OutstandingAssignments.make(
            ":memory:",
            fixture.client,
            roles,
            () => Effect.void,
          );
          yield* tracker.observeJoin(member);
          const poller = yield* Effect.forkChild(tracker.start());
          fixture.permissions = [{ id: ids.target, type: 1, permission: true }];
          yield* TestClock.adjust(4 * 60_000);
          expect(fixture.writes).toEqual([]);
          yield* TestClock.adjust(60_000);
          expect(fixture.writes).toHaveLength(1);
          yield* Fiber.interrupt(poller);
          const reads = fixture.memberReads;
          yield* TestClock.adjust(60 * 60_000);
          expect(fixture.memberReads).toBe(reads);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });
});

test("autorole module handles a join and removes its listeners on scope exit", async () => {
  await withDiscord(async (fixture) => {
    const { member } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    const written = Promise.withResolvers<void>();
    fixture.onRoleWrite = written.resolve;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const module = yield* makeAutorole(fixture.client, {
            path: ":memory:",
            report: () => Effect.void,
          });
          yield* install(fixture.client, module.commands, module.events, () => Effect.void);
          fixture.client.emit(Events.GuildMemberAdd, member);
          yield* tryPromise(() => written.promise);
        }),
      ),
    );
    expect(fixture.writes).toEqual([Routes.guildMemberRole(ids.guild, ids.member, ids.target)]);
    expect(fixture.client.listenerCount(Events.GuildMemberAdd)).toBe(0);
    expect(fixture.client.listenerCount(Events.GuildMemberUpdate)).toBe(0);
    expect(fixture.client.listenerCount(Events.GuildMemberAvailable)).toBe(0);
  });
});

test("autorole command catalog dispatches target and permission-denied status", async () => {
  const { MessageFlags } = await import("discord.js");
  const registry = makeCommandRegistry(new RoleService());
  let targetReply: unknown;
  let statusReply = "";
  let deferred: unknown;
  const target = {
    commandName: "autorole-target",
    reply: async (response: unknown) => {
      targetReply = response;
    },
  } as unknown as import("discord.js").ChatInputCommandInteraction;
  const status = {
    commandName: "autorole",
    guild: null,
    guildId: "guild",
    memberPermissions: new PermissionsBitField(
      PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles,
    ),
    options: { getSubcommand: () => "status", getSubcommandGroup: () => null },
    deferReply: async (options: unknown) => {
      deferred = options;
    },
    editReply: async (content: string) => {
      statusReply = content;
    },
  } as unknown as import("discord.js").ChatInputCommandInteraction;
  await Effect.runPromise(registry.dispatch(target));
  await Effect.runPromise(registry.dispatch(status));
  expect(targetReply).toMatchObject({
    flags: MessageFlags.Ephemeral,
    content: expect.stringContaining("Server Settings > Integrations"),
  });
  expect(deferred).toEqual({ flags: MessageFlags.Ephemeral });
  expect(statusReply).toBe("You need Manage Server and Manage Roles to inspect autorole settings.");
});

test("autorole status routes an authorized interaction and uses the configured role", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    const registry = makeCommandRegistry(roles);
    let deferred: unknown;
    let message = "";
    const interaction = {
      commandName: "autorole",
      guild: member.guild,
      guildId: member.guild.id,
      memberPermissions: new PermissionsBitField(
        PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles,
      ),
      options: { getSubcommand: () => "status", getSubcommandGroup: () => null },
      deferReply: async (value: unknown) => {
        deferred = value;
      },
      editReply: async (value: string) => {
        message = value;
      },
    } as unknown as import("discord.js").ChatInputCommandInteraction;
    await Effect.runPromise(registry.dispatch(interaction));
    const { MessageFlags } = await import("discord.js");
    expect(deferred).toEqual({ flags: MessageFlags.Ephemeral });
    expect(message).toContain(`Autorole: <@&${ids.target}>`);
  });
});
