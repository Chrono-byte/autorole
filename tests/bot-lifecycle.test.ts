import { expect, spyOn, test } from "bun:test";
import { Client, Events } from "discord.js";
import { Effect } from "effect";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAutorole } from "../src/bot/AutoroleBot";
import { JobWorker } from "../packages/jobs/worker";

const configuration = { token: "fixture", applicationId: "100000000000000001", guildId: undefined };

async function withBotEnvironment(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "autorole-lifecycle-"));
  const previous = {
    path: process.env.PATH,
    state: process.env.AUTOROLE_STATE_PATH,
    notify: process.env.NOTIFY_SOCKET,
    exitCode: process.exitCode,
  };
  process.env.AUTOROLE_STATE_PATH = join(directory, "assignments.sqlite");
  try {
    await run(directory);
  } finally {
    for (const [key, value] of [
      ["PATH", previous.path],
      ["AUTOROLE_STATE_PATH", previous.state],
      ["NOTIFY_SOCKET", previous.notify],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = previous.exitCode ?? 0;
    await rm(directory, { recursive: true, force: true });
  }
}

function mockClient(ready: () => void, calls: string[]) {
  const reconcile = spyOn(JobWorker.prototype, "reconcile").mockImplementation(() =>
    Effect.sync(() => {
      calls.push("reconcile");
    }),
  );
  const login = spyOn(Client.prototype, "login").mockImplementation(async function (this: Client) {
    calls.push("login");
    expect(this.listenerCount(Events.GuildMemberAdd)).toBe(1);
    expect(this.listenerCount(Events.ClientReady)).toBe(1);
    Object.defineProperty(this, "user", {
      value: {
        tag: "fixture",
        setPresence: () => {
          calls.push("presence");
          ready();
        },
      },
      configurable: true,
    });
    this.emit(Events.ClientReady, this as Client<true>);
    return "fixture";
  });
  const destroy = spyOn(Client.prototype, "destroy").mockImplementation(async function (
    this: Client,
  ) {
    calls.push("destroy");
    expect(this.listenerCount(Events.GuildMemberAdd)).toBe(0);
    expect(this.listenerCount(Events.InteractionCreate)).toBe(0);
  });
  return () => {
    reconcile.mockRestore();
    login.mockRestore();
    destroy.mockRestore();
  };
}

test("autorole owns login, ready events and scoped shutdown", async () => {
  await withBotEnvironment(async () => {
    delete process.env.NOTIFY_SOCKET;
    const ready = Promise.withResolvers<void>();
    const calls: string[] = [];
    const restore = mockClient(ready.resolve, calls);
    const abort = new AbortController();
    const running = Effect.runPromise(Effect.scoped(runAutorole(configuration)), {
      signal: abort.signal,
    });
    const completed = running.then(
      () => "completed",
      () => "interrupted",
    );
    try {
      await ready.promise;
      abort.abort();
      expect(await completed).toBe("interrupted");
      expect(calls).toEqual(["login", "reconcile", "presence", "destroy"]);
    } finally {
      abort.abort();
      await completed;
      restore();
    }
  });
});

test("readiness notification failure stops autorole and closes the client", async () => {
  await withBotEnvironment(async (directory) => {
    const helper = join(directory, "systemd-notify");
    await writeFile(helper, "#!/bin/sh\nexit 1\n");
    await chmod(helper, 0o700);
    process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
    process.env.NOTIFY_SOCKET = "/test/socket";
    const calls: string[] = [];
    const restore = mockClient(() => {}, calls);
    try {
      await Effect.runPromise(Effect.scoped(runAutorole(configuration)));
      expect(process.exitCode).toBe(1);
      expect(calls).toEqual(["login", "reconcile", "presence", "destroy"]);
    } finally {
      restore();
    }
  });
});
