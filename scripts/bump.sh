#!/usr/bin/env bash
#
# Bump a package version.
#
# Usage:
#   scripts/bump.sh <package-dir> [patch|minor|major]
#   Defaults to minor.
#
# Requires: jq

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <package-dir> [patch|minor|major]"
  exit 1
fi

dir="$1"
bump="${2:-minor}"
pkg_json="${dir}/package.json"

if [ ! -f "$pkg_json" ]; then
  echo "Error: ${pkg_json} not found."
  exit 1
fi

current=$(jq -r .version "$pkg_json")
IFS='.' read -r major minor patch <<< "$current"

case "$bump" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
  *)
    echo "Error: bump type must be patch, minor, or major."
    exit 1
    ;;
esac

next="${major}.${minor}.${patch}"

jq --arg v "$next" '.version = $v' \
  "$pkg_json" > "${pkg_json}.tmp"
mv "${pkg_json}.tmp" "$pkg_json"

lockfile="bun.lock"
if [ -f "$lockfile" ]; then
  dir_escaped="${dir//\//\\/}"
  sed "/\"${dir_escaped}\": {/,/\"version\":/ {
    s/\"version\": \"[^\"]*\"/\"version\": \"$next\"/
  }" "$lockfile" > "${lockfile}.tmp"
  mv "${lockfile}.tmp" "$lockfile"
fi

echo "${current} → ${next}"

# Bumping core past the adapter's declared peer ceiling is the
# mistake this catches at the moment it is made, rather than in
# CI or -- as it once did -- on npm. Advisory here: reshaping the
# range is a judgement call, and the bump itself is already done.
if ! "$(dirname "$0")/check-peer-range.sh"; then
  echo
  echo "warning: @tsfga/kysely's peer range no longer matches" \
    "@tsfga/core. Fix it in this same change."
fi
