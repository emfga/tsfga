#!/usr/bin/env bash
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR"

bun run biome:format
bun run biome:check || exit 2
bun run tsc || exit 2
bun run turbo:test || exit 2
