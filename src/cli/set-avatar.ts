import { REST, Routes } from "discord.js";
import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";
import { readConfiguration, type Configuration } from "../config/Configuration";
import { tryPromise, trySync } from "../effectful";
import { discordRequest } from "../errors";
import { runMain } from "../runMain";
import { runCommand } from "../runCommand";

class BotAvatarUpdater {
  private readonly rest: REST;

  constructor(config: Configuration) {
    this.rest = new REST({ version: "10" }).setToken(config.token);
  }

  run(pngPath?: string): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const bytes = pngPath
        ? yield* tryPromise((signal) => readFile(pngPath, { signal }))
        : yield* this.download();
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return yield* Effect.fail(new Error("The avatar must be a PNG image."));
      const padded = yield* this.pad(bytes);
      const updated = yield* discordRequest((signal) =>
        this.rest.patch(Routes.user("@me"), {
          signal,
          body: { avatar: `data:image/png;base64,${padded.toString("base64")}` },
        }),
      );
      const avatar = yield* trySync(() => BotAvatarUpdater.avatarHash(updated));
      const verified = yield* discordRequest((signal) =>
        this.rest.get(Routes.user("@me"), { signal }),
      );
      const verifiedAvatar = yield* trySync(() => BotAvatarUpdater.avatarHash(verified));
      if (verifiedAvatar !== avatar)
        return yield* Effect.fail(new Error("Discord's avatar did not match the update."));
      yield* Effect.sync(() =>
        process.stdout.write("Bot avatar updated and verified on Discord.\n"),
      );
    });
  }

  private pad(bytes: Buffer): Effect.Effect<Buffer, Error> {
    const source = "assets/athena-source.png";
    const output = "assets/athena-avatar.png";
    return Effect.gen(function* () {
      yield* tryPromise((signal) => writeFile(source, bytes, { signal }));
      yield* runCommand("swift", [
        "-module-cache-path",
        ".tmp/swift-cache",
        fileURLToPath(new URL("../../scripts/pad-avatar.swift", import.meta.url)),
        source,
        output,
      ]);
      yield* Effect.sync(() => process.stdout.write(`Saved padded avatar to ${output}.\n`));
      return yield* tryPromise((signal) => readFile(output, { signal }));
    });
  }

  private download(): Effect.Effect<Buffer, Error> {
    return tryPromise(async (signal) => {
      const response = await fetch(
        "https://public.vocalize.studio/voice_images/15622/aivoicemainimage.png",
        { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) },
      );
      if (!response.ok) throw new Error(`Avatar download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    });
  }

  private static avatarHash(user: unknown) {
    if (
      typeof user !== "object" ||
      user === null ||
      !("avatar" in user) ||
      typeof user.avatar !== "string"
    ) {
      throw new Error("Discord did not return a bot avatar.");
    }
    return user.avatar;
  }
}

const program = Effect.gen(function* () {
  const configuration = yield* readConfiguration();
  const updater = yield* trySync(() => new BotAvatarUpdater(configuration));
  yield* updater.run(process.argv[2]);
});
await runMain(program, "avatar_update_failed");
