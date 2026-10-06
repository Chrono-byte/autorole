import { expect, test } from "bun:test";
import { notifyReady } from "../src/bot/notifyReady";

test("local startup skips systemd notification", async () => {
  let calls = 0;
  await notifyReady("", async () => {
    calls++;
  });
  expect(calls).toBe(0);
});

test("readiness waits for notification completion and propagates failure", async () => {
  let complete = false;
  await notifyReady("/run/notify", async () => {
    await Promise.resolve();
    complete = true;
  });
  expect(complete).toBe(true);
  await expect(
    notifyReady("/run/notify", async () => {
      throw new Error("notification failed");
    }),
  ).rejects.toThrow("notification failed");
});

test("notification invokes the helper and detects helper failure", async () => {
  const { mkdtemp, chmod, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "autorole-ready-"));
  try {
    const helper = join(directory, "systemd-notify");
    const output = join(directory, "notification");
    await Bun.write(
      helper,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$NOTIFY_OUTPUT"\nexit "${NOTIFY_EXIT:-0}"\n',
    );
    await chmod(helper, 0o700);
    const source = resolve("src/bot/notifyReady.ts");
    async function run(exit: string) {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { notifyReady } from ${JSON.stringify(source)}; await notifyReady();`,
        ],
        {
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            NOTIFY_SOCKET: "/test/socket",
            NOTIFY_OUTPUT: output,
            NOTIFY_EXIT: exit,
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      return await child.exited;
    }
    expect(await run("0")).toBe(0);
    expect(await Bun.file(output).text()).toBe("--ready\n--status=Connected to Discord\n");
    expect(await run("1")).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
