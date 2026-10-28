import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { tryPromise } from "../src/effectful";
import { runCommand } from "../src/runCommand";
import { runMain } from "../src/runMain";

async function waitForFile(path: string) {
  const deadline = Date.now() + 2000;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await delay(10);
  }
}

test("interrupting a command terminates its subprocess", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autorole-cancel-"));
  const helper = join(directory, "helper.js");
  const ready = join(directory, "ready");
  const terminated = join(directory, "terminated");
  const shutdown = new AbortController();
  await writeFile(
    helper,
    `
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => { writeFileSync(process.argv[3], "terminated"); process.exit(0); });
    writeFileSync(process.argv[2], String(process.pid));
    setInterval(() => {}, 1000);
  `,
  );
  const result = Effect.runPromise(runCommand(process.execPath, [helper, ready, terminated]), {
    signal: shutdown.signal,
  });
  // Observe the rejection immediately, including if setup fails before cancellation.
  const completed = result.then(
    () => "success",
    () => "interrupted",
  );
  try {
    await waitForFile(ready);
    shutdown.abort();
    expect(await completed).toBe("interrupted");
    await waitForFile(terminated);
    expect(await readFile(terminated, "utf8")).toBe("terminated");
  } finally {
    shutdown.abort();
    if (await Bun.file(ready).exists()) {
      const pid = Number(await readFile(ready, "utf8"));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    await completed;
    await rm(directory, { recursive: true, force: true });
  }
});

test("entrypoint signals interrupt effects and remove their listeners", async () => {
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  const started = Promise.withResolvers<AbortSignal>();
  const running = runMain(
    tryPromise((signal) => {
      started.resolve(signal);
      return new Promise<void>(() => {});
    }),
    "test_failure",
  );
  const signal = await started.promise;
  process.emit("SIGTERM", "SIGTERM");
  await running;
  expect(signal.aborted).toBe(true);
  expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
  expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
});
