#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "$#" -eq 0 ] || { echo "Usage: bun run deploy (dispatches the main workflow)" >&2; exit 2; }
command -v fj >/dev/null || { echo "Install and authenticate fj, or run Deploy Athena from Forgejo Actions." >&2; exit 1; }
exec fj actions dispatch deploy.yml main
