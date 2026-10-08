#!/bin/sh
set -eu
umask 077

cd "$(dirname "$0")/.."
deploy_host=${1:-chrono@osiris}

bun run check
bun run build:binary
mkdir -p .tmp/deploy
# Export only the runtime configuration, never the rest of the local environment.
bun -e '
import { readConfiguration } from "./src/config/Configuration";
const config = readConfiguration();
const values = {
  DISCORD_TOKEN: config.token,
  DISCORD_APPLICATION_ID: config.applicationId,
  DISCORD_GUILD_ID: config.guildId,
};
const lines = Object.entries(values)
  .filter(([, value]) => value !== undefined)
  .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
await Bun.write(".tmp/deploy/runtime.env", lines.join("\n") + "\n");
if (Buffer.from(await Bun.file("dist/autorole").arrayBuffer()).includes(Buffer.from(config.token))) {
  throw new Error("Refusing to deploy an executable containing the bot token");
}
'
chmod 600 .tmp/deploy/runtime.env

ssh -o BatchMode=yes -o ConnectTimeout=10 "$deploy_host" '
  set -eu
  command -v systemd-notify >/dev/null
  umask 077
  mkdir -p .local/share/autorole .config/autorole .config/systemd/user
  chmod 700 .config/autorole
'
scp -o BatchMode=yes -o ConnectTimeout=10 .tmp/deploy/runtime.env "$deploy_host:.config/autorole/env.new"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$deploy_host" '
  set -eu
  chmod 600 .config/autorole/env.new
  mv .config/autorole/env.new .config/autorole/env
'
sh scripts/deploy-artifact.sh "$deploy_host"
