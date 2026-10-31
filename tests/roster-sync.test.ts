import { expect, test } from "bun:test";
import { Collection, PermissionFlagsBits, PermissionsBitField, type Guild } from "discord.js";
import { Effect } from "effect";
import {
  playerRoleId,
  rosterGuildId,
  syncRoster,
  teamRoleIds,
} from "../src/bot/commands/syncRoster";

function fixture() {
  const writes: string[] = [];
  const playerRole = { id: playerRoleId, managed: false };
  const actor = { roles: { highest: { comparePositionTo: () => 1 } } };
  const bot = {
    permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
    roles: { highest: { comparePositionTo: () => 1 } },
  };
  const roleList = new Collection<string, unknown>([
    [playerRoleId, playerRole],
    ...teamRoleIds.map((id): [string, unknown] => [id, { id }]),
  ]);
  const roster = new Collection<string, ReturnType<typeof member>>();
  let failList = false;
  let failWrite = "";
  function member(id: string, roleIds: string[]) {
    return {
      id,
      roles: {
        cache: new Collection(roleIds.map((role) => [role, { id: role }])),
        add: async () => {
          if (id === failWrite) throw new Error("denied");
          writes.push(`add:${id}`);
        },
        remove: async () => {
          if (id === failWrite) throw new Error("denied");
          writes.push(`remove:${id}`);
        },
      },
    };
  }
  const guild = {
    id: rosterGuildId,
    ownerId: "owner",
    roles: { fetch: async () => roleList },
    members: {
      fetchMe: async () => bot,
      fetch: async ({ user }: { user: string }) => (user === "actor" ? actor : roster.get(user)),
      list: async () => {
        if (failList) throw new Error("incomplete list");
        return roster;
      },
    },
  } as unknown as Guild;
  return {
    guild,
    roster,
    member,
    writes,
    bot,
    actor,
    roleList,
    failList: () => {
      failList = true;
    },
    failWrite: (id: string) => {
      failWrite = id;
    },
  };
}

test("roster sync adds and removes Player and reports per-member failures", async () => {
  const f = fixture();
  for (const [id, roles] of [
    ["add", [teamRoleIds[0]]],
    ["remove", [playerRoleId]],
    ["keep", [playerRoleId, teamRoleIds[1]]],
    ["none", []],
    ["fail", [teamRoleIds[2]]],
  ] as const)
    f.roster.set(id, f.member(id, [...roles]));
  f.failWrite("fail");
  expect(await Effect.runPromise(syncRoster(f.guild, "actor"))).toEqual({
    added: 1,
    removed: 1,
    failed: 1,
  });
  expect(f.writes).toEqual(["add:add", "remove:remove"]);
});

test("roster sync makes no changes if the member list fails or a required role is missing", async () => {
  const f = fixture();
  f.roster.set("add", f.member("add", [teamRoleIds[0]]));
  f.failList();
  await expect(Effect.runPromise(syncRoster(f.guild, "actor"))).rejects.toThrow();
  expect(f.writes).toEqual([]);
  f.roleList.delete(teamRoleIds[0]);
  await expect(Effect.runPromise(syncRoster(f.guild, "actor"))).rejects.toThrow("role is missing");
  expect(f.writes).toEqual([]);
});

test("roster sync rejects a caller or bot below Player", async () => {
  const f = fixture();
  f.actor.roles.highest.comparePositionTo = () => -1;
  await expect(Effect.runPromise(syncRoster(f.guild, "actor"))).rejects.toThrow(
    "Your highest role",
  );
  f.bot.roles.highest.comparePositionTo = () => -1;
  await expect(Effect.runPromise(syncRoster(f.guild, "owner"))).rejects.toThrow(
    "bot's highest role",
  );
  expect(f.writes).toEqual([]);
});

test("a later member-list page failure prevents every change", async () => {
  const f = fixture();
  const firstPage = new Collection<string, ReturnType<typeof f.member>>();
  for (let i = 0; i < 1000; i++) {
    const id = String(i + 1);
    firstPage.set(id, f.member(id, [teamRoleIds[0]]));
  }
  let pages = 0;
  f.guild.members.list = async () => {
    pages++;
    if (pages === 1) return firstPage as never;
    throw new Error("second page failed");
  };
  await expect(Effect.runPromise(syncRoster(f.guild, "actor"))).rejects.toThrow(
    "second page failed",
  );
  expect(pages).toBe(2);
  expect(f.writes).toEqual([]);
});

test("the roster command enforces member and bot permissions before reading members", async () => {
  const { makeCommandRegistry } = await import("../src/bot/commands/AutoroleCommands");
  const { RoleService } = await import("../src/bot/RoleService");
  const registry = makeCommandRegistry(new RoleService());
  const f = fixture();
  let read = false;
  f.guild.roles.fetch = async () => {
    read = true;
    throw new Error("unexpected role read");
  };
  const interaction = {
    commandName: "sync-roster",
    guildId: rosterGuildId,
    guild: f.guild,
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    appPermissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
  } as unknown as import("discord.js").ChatInputCommandInteraction;
  await expect(Effect.runPromise(registry.dispatch(interaction))).rejects.toThrow();
  interaction.memberPermissions = new PermissionsBitField(
    PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles,
  );
  interaction.appPermissions = new PermissionsBitField(0n);
  await expect(Effect.runPromise(registry.dispatch(interaction))).rejects.toThrow();
  expect(read).toBe(false);
});
