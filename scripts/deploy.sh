#!/bin/sh
set -eu
umask 077

cd "$(dirname "$0")/.."
deploy_host=${1:-chrono@hermes}

bun run check
bun run build:binary
mkdir -p .tmp/deploy
# Export only the runtime configuration, never the rest of the local environment.
bun -e '
import { Configuration } from "./src/Configuration";
const config = new Configuration();
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
  umask 077
  mkdir -p .local/share/autorole .config/autorole .config/systemd/user
  chmod 700 .config/autorole
'
scp -o BatchMode=yes -o ConnectTimeout=10 dist/autorole "$deploy_host:.local/share/autorole/autorole.new"
scp -o BatchMode=yes -o ConnectTimeout=10 .tmp/deploy/runtime.env "$deploy_host:.config/autorole/env.new"
scp -o BatchMode=yes -o ConnectTimeout=10 deploy/autorole.service "$deploy_host:.config/systemd/user/autorole.service.new"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$deploy_host" '
  set -eu
  chmod 700 .local/share/autorole/autorole.new
  chmod 600 .config/autorole/env.new .config/systemd/user/autorole.service.new
  mv .local/share/autorole/autorole.new .local/share/autorole/autorole
  mv .config/autorole/env.new .config/autorole/env
  mv .config/systemd/user/autorole.service.new .config/systemd/user/autorole.service
  systemctl --user daemon-reload
  systemctl --user enable autorole.service
  systemctl --user restart autorole.service
  systemctl --user is-active autorole.service
'
