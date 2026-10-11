import { expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  Client,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  Routes,
  type ApplicationCommandPermissions,
} from "discord.js";
import { AssignmentQueue } from "../src/bot/AssignmentQueue";
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
  bot = false;
  existingRoles: string[] = [];
  readonly writes: string[] = [];
  private readonly get = spyOn(this.client.rest, "get").mockImplementation(async (route) => {
    if (route === Routes.guild(ids.guild)) {
      return {
        id: ids.guild,
        name: "Test server",
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
        pending: this.pending,
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
    const config = readConfiguration({
      DISCORD_TOKEN: "fixture",
      DISCORD_APPLICATION_ID: ids.app,
      ...(this.global ? {} : { DISCORD_GUILD_ID: ids.guild }),
    });
    const guild = await this.client.guilds.fetch({ guild: ids.guild, force: true });
    const member = await guild.members.fetch({ user: ids.member, force: true });
    return { member, roles: new RoleService(new IntegrationSettings(config.guildId)) };
  }

  async assign() {
    const { member, roles } = await this.setup();
    await roles.assign(member);
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
    const config = readConfiguration({
      DISCORD_TOKEN: "fixture",
      DISCORD_APPLICATION_ID: ids.app,
      DISCORD_GUILD_ID: ids.guild,
    });
    const roles = new RoleService(new IntegrationSettings(config.guildId));
    const guild = await fixture.client.guilds.fetch(ids.guild);
    expect((await roles.getConfiguredRole(guild))?.id).toBe(ids.target);
    fixture.permissions = [];
    expect(await roles.getConfiguredRole(guild)).toBeNull();
    fixture.permissions = [{ id: ids.target, type: 1, permission: true }];
    fixture.permissionRequestFails = true;
    await expect(roles.getConfiguredRole(guild)).rejects.toThrow("permissions unavailable");
    expect(fixture.writes).toEqual([]);
  });
});

test("queue recovers from a transient failure and deduplicates events", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    fixture.permissionRequestFails = true;
    fixture.permissionError = new HTTPError(503, "Unavailable", "GET", "https://discord.com", {});
    const attempts: number[] = [];
    const queue = new AssignmentQueue(
      roles,
      (_error, _member, attempt, retrying) => {
        attempts.push(attempt);
        expect(retrying).toBe(true);
        fixture.permissionRequestFails = false;
      },
      [1],
    );
    const first = queue.enqueue(member);
    expect(queue.enqueue(member)).toBe(first);
    await first;
    expect(attempts).toEqual([1]);
    expect(fixture.writes).toEqual([Routes.guildMemberRole(ids.guild, ids.member, ids.target)]);
    queue.stop();
  });
});

for (const change of ["replacement", "disabled", "pending", "existing"]) {
  test(`retry rechecks current member and configuration: ${change}`, async () => {
    await withDiscord(async (fixture) => {
      const { member, roles } = await fixture.setup();
      fixture.permissionRequestFails = true;
      fixture.permissionError = Object.assign(new Error("network reset"), { code: "ECONNRESET" });
      const queue = new AssignmentQueue(roles, () => {
        fixture.permissionRequestFails = false;
        if (change === "replacement")
          fixture.permissions = [{ id: ids.replacement, type: 1, permission: true }];
        if (change === "disabled") fixture.permissions = [];
        if (change === "pending") fixture.pending = true;
        if (change === "existing") fixture.existingRoles = [ids.target];
      }, [1]);
      await queue.enqueue(member);
      expect(fixture.writes).toEqual(
        change === "replacement"
          ? [Routes.guildMemberRole(ids.guild, ids.member, ids.replacement)]
          : [],
      );
      queue.stop();
    });
  });
}

test("queue does not retry permanent errors", async () => {
  await withDiscord(async (fixture) => {
    fixture.manageRoles = false;
    const { member, roles } = await fixture.setup();
    const reports: boolean[] = [];
    const queue = new AssignmentQueue(
      roles,
      (_error, _member, _attempt, retrying) => reports.push(retrying),
      [1],
    );
    await queue.enqueue(member);
    expect(reports).toEqual([false]);
    expect(fixture.writes).toEqual([]);
    queue.stop();
  });
});

test("queue exhausts bounded retries", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    fixture.permissionRequestFails = true;
    fixture.permissionError = new HTTPError(503, "Unavailable", "GET", "https://discord.com", {});
    const reports: boolean[] = [];
    const queue = new AssignmentQueue(
      roles,
      (_error, _member, _attempt, retrying) => reports.push(retrying),
      [1, 1, 1],
    );
    await queue.enqueue(member);
    expect(reports).toEqual([true, true, true, false]);
    expect(fixture.writes).toEqual([]);
    queue.stop();
  });
});

test("shutdown cancels pending retries and rejects new work", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    fixture.permissionRequestFails = true;
    fixture.permissionError = Object.assign(new Error("network reset"), { code: "ECONNRESET" });
    let reports = 0;
    const queue = new AssignmentQueue(roles, () => {
      reports++;
      queue.stop();
    }, [30000]);
    await queue.enqueue(member);
    await queue.enqueue(member);
    expect(reports).toBe(1);
    expect(fixture.writes).toEqual([]);
  });
});

test("retry stops when the member has left", async () => {
  await withDiscord(async (fixture) => {
    const { member, roles } = await fixture.setup();
    fixture.permissionRequestFails = true;
    fixture.permissionError = Object.assign(new Error("network reset"), { code: "ECONNRESET" });
    let reports = 0;
    const queue = new AssignmentQueue(roles, () => {
      reports++;
      fixture.memberLeft = true;
    }, [1, 1]);
    await queue.enqueue(member);
    expect(reports).toBe(1);
    expect(fixture.writes).toEqual([]);
    queue.stop();
  });
});
