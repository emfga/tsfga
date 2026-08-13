#!/usr/bin/env bash
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR"

# Format, lint and type check only. The test suite is deliberately
# not here: it needs the shared Postgres and OpenFGA containers, so
# a hook run collides with any agent already testing against them —
# every conformance file holds an open transaction and OpenFGA store
# creation is global. Those collisions produce spurious failures and,
# worse, spurious passes. Run tests deliberately instead; see
# CLAUDE.md, "Running tests".
bun run biome:format
bun run biome:check || exit 2
bun run tsc || exit 2
