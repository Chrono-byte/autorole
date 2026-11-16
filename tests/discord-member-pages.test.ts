import { expect, test } from "bun:test";
import { Collection, type Guild } from "discord.js";
import { Effect } from "effect";
import { forEachGuildMember } from "@autorole/discord-framework";

function memberPage(start: number, count: number) {
  return new Collection(
    Array.from({ length: count }, (_, offset) => {
      const id = String(start + offset);
      return [id, { id }] as const;
    }),
  );
}

test("member pagination visits every member and requests uncached pages using the last ID", async () => {
  const requests: unknown[] = [];
  const pages = [memberPage(1, 1000), memberPage(1001, 1)];
  const guild = {
    members: {
      list: async (options: unknown) => {
        requests.push(options);
        return pages.shift();
      },
    },
  } as unknown as Guild;
  const visited: string[] = [];
  await Effect.runPromise(
    forEachGuildMember(
      guild,
      (member) =>
        Effect.sync(() => {
          visited.push(member.id);
        }),
      new Error("incomplete"),
    ),
  );
  expect(visited).toHaveLength(1001);
  expect(visited[0]).toBe("1");
  expect(visited.at(-1)).toBe("1001");
  expect(new Set(visited).size).toBe(1001);
  expect(requests).toEqual([
    { limit: 1000, after: undefined, cache: false },
    { limit: 1000, after: "1000", cache: false },
  ]);
});

test("member pagination stops a repeated full page with the caller's incomplete error", async () => {
  let requests = 0;
  const guild = {
    members: {
      list: async () => {
        requests++;
        return memberPage(1, 1000);
      },
    },
  } as unknown as Guild;
  const incomplete = new Error("Cannot reconcile an incomplete roster");
  await expect(
    Effect.runPromise(forEachGuildMember(guild, () => Effect.void, incomplete)),
  ).rejects.toThrow(incomplete.message);
  expect(requests).toBe(2);
});

test("member pagination preserves visitor failures and stops requesting pages", async () => {
  let requests = 0;
  const guild = {
    members: {
      list: async () => {
        requests++;
        return memberPage(1, 1000);
      },
    },
  } as unknown as Guild;
  await expect(
    Effect.runPromise(
      forEachGuildMember(
        guild,
        () => Effect.fail(new Error("store failed")),
        new Error("incomplete"),
      ),
    ),
  ).rejects.toThrow("store failed");
  expect(requests).toBe(1);
});
