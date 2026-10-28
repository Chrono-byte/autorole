import { expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  Client,
  DiscordAPIError,
  PermissionFlagsBits,
  Routes,
  type ApplicationCommandPermissions,
} from "discord.js";
import { Effect, Fiber } from "effect";
import { OutstandingAssignments } from "../src/bot/OutstandingAssignments";
import { readConfiguration } from "../src/config/Configuration";
import { IntegrationSettings } from "../src/config/IntegrationSettings";
import { RoleService } from "../src/bot/RoleService";
import { AutoroleCommands } from "../src/bot/AutoroleCommands";

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
  bot = false;
  existingRoles: string[] = [];
  readonly writes: string[] = [];
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
          ...AutoroleCommands.definitions
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
      const capturedPending = this.pending;
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
    return { member, roles: new RoleService(new IntegrationSettings(config.guildId)) };
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
  expect(AutoroleCommands.definitions.map((definition) => definition.toJSON().name)).toEqual([
    "autorole",
    "autorole-target",
  ]);
  expect(
    AutoroleCommands.definitions
      .find((definition) => definition.name === "autorole-target")
      ?.toJSON(),
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
    const roles = new RoleService(new IntegrationSettings(config.guildId));
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

test("outstanding screening survives restart and assigns the current target", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    member.guild.available = true;
    fixture.client.guilds.cache.set(member.guild.id, member.guild);
    const path = `/tmp/autorole-test-${crypto.randomUUID()}.sqlite`;
    fixture.pending = true;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* OutstandingAssignments.make(
            path,
            fixture.client,
            roles,
            () => Effect.void,
          );
          yield* first.observeJoin(member);
          yield* first.reconcile();
        }),
      ),
    );
    expect(fixture.writes).toEqual([]);
    fixture.pending = false;
    fixture.permissions = [{ id: ids.replacement, type: 1, permission: true }];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const second = yield* OutstandingAssignments.make(
            path,
            fixture.client,
            roles,
            () => Effect.void,
          );
          yield* second.observe(member);
        }),
      ),
    );
    expect(fixture.writes).toEqual([
      Routes.guildMemberRole(ids.guild, ids.member, ids.replacement),
    ]);
    await Bun.file(path).delete();
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
          yield* Effect.sleep(10);
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
          yield* Effect.sleep(10);
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
            yield* Effect.sleep(5);
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
