#!/usr/bin/env bash
#
# Assert that @tsfga/kysely's declared peer range on
# @tsfga/core admits the version of @tsfga/core in this repo.
#
# Why this exists: the range used to be "workspace:*", which the
# release workflow rewrote to "^<core version>" at publish time.
# Below 1.0.0, caret pins a single minor -- "^0.4.0" means
# ">=0.4.0 <0.5.0" -- so publishing core 0.5.0 orphaned the last
# published adapter without any step failing. Nobody was ever
# asked whether the adapter still worked with the new core,
# because no human wrote the range down.
#
# So the range is hand-written in package.json now, and this
# check runs in CI: bumping core past the declared ceiling turns
# into a red build on the bump PR, and the fix is a deliberate
# decision -- widen the ceiling if the adapter still works,
# raise the floor if it does not.
#
# The range must be spelled ">=A.B.C <D.E.F". An explicit
# ceiling is the point: "^" and "~" change meaning at 1.0.0,
# which is precisely the trap this guards.
#
# Usage: scripts/check-peer-range.sh
# Requires: jq

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
core_json="${root}/packages/core/package.json"
kysely_json="${root}/packages/kysely/package.json"

core_ver=$(jq -r .version "$core_json")
range=$(jq -r '.peerDependencies["@tsfga/core"]' "$kysely_json")
dev=$(jq -r '.devDependencies["@tsfga/core"]' "$kysely_json")

fail() {
  echo "::error::$1"
  echo "  @tsfga/core version:     ${core_ver}"
  echo "  @tsfga/kysely peer range: ${range}"
  exit 1
}

# Local resolution comes from the devDependency, so the peer
# range is free to be a published range rather than a workspace
# link. If the devDependency stops being the link, the adapter
# starts type-checking against a registry copy of core instead
# of the source next to it.
if [ "$dev" != "workspace:*" ]; then
  fail "packages/kysely devDependency on @tsfga/core must stay
  \"workspace:*\" (found \"${dev}\"), or the adapter no longer
  builds against the core in this repo."
fi

pattern='^>=([0-9]+\.[0-9]+\.[0-9]+) <([0-9]+\.[0-9]+\.[0-9]+)$'
if [[ ! "$range" =~ $pattern ]]; then
  fail "peer range must be spelled \">=A.B.C <D.E.F\" with an
  explicit ceiling. Caret and tilde ranges are rejected because
  their meaning changes at 1.0.0."
fi

floor="${BASH_REMATCH[1]}"
ceiling="${BASH_REMATCH[2]}"

# sort -V orders versions; the lowest of a pair tells us which
# side of the comparison the core version falls on.
lowest() { printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1; }

if [ "$(lowest "$core_ver" "$floor")" != "$floor" ]; then
  fail "@tsfga/core ${core_ver} is below the declared floor
  ${floor}. Lower the floor, or bump core."
fi

if [ "$core_ver" = "$ceiling" ] \
  || [ "$(lowest "$core_ver" "$ceiling")" = "$ceiling" ]; then
  fail "@tsfga/core ${core_ver} is at or above the declared
  ceiling ${ceiling}, so @tsfga/kysely would publish a peer
  range that excludes the core it was built and tested against.
  Decide explicitly: widen the ceiling in
  packages/kysely/package.json if the adapter still works with
  core ${core_ver}, or raise the floor if this core requires
  adapter changes. Either way, bump @tsfga/kysely and record it
  in its CHANGELOG."
fi

echo "@tsfga/kysely peer range ${range} admits @tsfga/core" \
  "${core_ver}."
