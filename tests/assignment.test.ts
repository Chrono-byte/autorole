import { expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  Client,
  PermissionFlagsBits,
  Routes,
  type ApplicationCommandPermissions,
} from "discord.js";
import { Configuration } from "../src/Configuration";
import { IntegrationSettings } from "../src/IntegrationSettings";
import { RoleService } from "../src/RoleService";
import { AutoroleCommands } from "../src/AutoroleCommands";

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
      if (this.permissionRequestFails) throw new Error("Discord permissions unavailable");
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
    // Replay discord.js's READY handler to initialize real ClientUser and
    // ClientApplication objects without opening a network connection. All guild,
    // member, role and permission managers below are the real discord.js objects.
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

  async assign() {
    const config = new Configuration({
      DISCORD_TOKEN: "fixture",
      DISCORD_APPLICATION_ID: ids.app,
      ...(this.global ? {} : { DISCORD_GUILD_ID: ids.guild }),
    });
    const guild = await this.client.guilds.fetch({ guild: ids.guild, force: true });
    const member = await guild.members.fetch({ user: ids.member, force: true });
    await new RoleService(new IntegrationSettings(config)).assign(member);
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
    const config = new Configuration({
      DISCORD_TOKEN: "fixture",
      DISCORD_APPLICATION_ID: ids.app,
      DISCORD_GUILD_ID: ids.guild,
    });
    const roles = new RoleService(new IntegrationSettings(config));
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
