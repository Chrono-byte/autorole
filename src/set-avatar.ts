import { REST, Routes } from "discord.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const runCommand = promisify(execFile);
import { Configuration } from "./Configuration";

class BotAvatarUpdater {
  private readonly rest: REST;

  constructor(config: Configuration) {
    this.rest = new REST({ version: "10" }).setToken(config.token);
  }

  async run(pngPath?: string) {
    const bytes = pngPath
      ? Buffer.from(await Bun.file(pngPath).arrayBuffer())
      : await this.download();
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("The avatar must be a PNG image.");
    }
    const padded = await this.pad(bytes);
    const updated = await this.rest.patch(Routes.user("@me"), {
      body: { avatar: `data:image/png;base64,${padded.toString("base64")}` },
    });
    const avatar = BotAvatarUpdater.avatarHash(updated);
    const verified = await this.rest.get(Routes.user("@me"));
    if (BotAvatarUpdater.avatarHash(verified) !== avatar) {
      throw new Error("Discord's avatar did not match the update.");
    }
    process.stdout.write("Bot avatar updated and verified on Discord.\n");
  }

  private async pad(bytes: Buffer) {
    const source = "assets/athena-source.png";
    const output = "assets/athena-avatar.png";
    await Bun.write(source, bytes);
    await runCommand("swift", [
      "-module-cache-path",
      ".tmp/swift-cache",
      fileURLToPath(new URL("../scripts/pad-avatar.swift", import.meta.url)),
      source,
      output,
    ]);
    process.stdout.write(`Saved padded avatar to ${output}.\n`);
    return Buffer.from(await Bun.file(output).arrayBuffer());
  }

  private async download() {
    const response = await fetch(
      "https://public.vocalize.studio/voice_images/15622/aivoicemainimage.png",
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw new Error(`Avatar download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
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

try {
  await new BotAvatarUpdater(new Configuration()).run(process.argv[2]);
} catch (error) {
  process.stderr.write(
    `Avatar update failed: ${error instanceof Error ? error.message : "Unknown error"}\n`,
  );
  process.exitCode = 1;
}
