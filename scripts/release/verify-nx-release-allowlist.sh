#!/usr/bin/env bash
# scripts/release/verify-nx-release-allowlist.sh
#
# Verifies nx.json's `release.projects` matches the set of TypeScript
# packages enrolled in scripts/release/release.config.json.
#
# Why this matters: nx release publish initializes a release graph for
# every project in `release.projects`. If a project is in that list but
# isn't actually releasable (e.g. a starter template without versionActions),
# publish fails. Conversely, if a release.config.json package is NOT in
# nx.json, nx release publish will silently skip it.
#
# Both files must list the same TypeScript package names.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$REPO_ROOT/scripts/release/release.config.json"
NX_JSON="$REPO_ROOT/nx.json"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: $CONFIG not found" >&2
  exit 1
fi
if [ ! -f "$NX_JSON" ]; then
  echo "ERROR: $NX_JSON not found" >&2
  exit 1
fi

CONFIG_TS=$(jq -r '[.scopes[].packages[] | select(.ecosystem == "typescript") | .name] | sort | .[]' "$CONFIG")
NX_TS=$(jq -r '.release.projects // [] | sort | .[]' "$NX_JSON")

if [ "$CONFIG_TS" = "$NX_TS" ]; then
  echo "OK: nx.json release.projects matches release.config.json TypeScript packages"
  exit 0
fi

echo "ERROR: nx.json release.projects and release.config.json TypeScript packages are out of sync." >&2
echo "" >&2
echo "--- diff (release.config.json vs nx.json) ---" >&2
diff <(echo "$CONFIG_TS") <(echo "$NX_TS") || true >&2
echo "" >&2
echo "Fix: update nx.json's release.projects to match release.config.json's TypeScript package names," >&2
echo "or vice versa. Both files must agree so nx release publish sees the correct allowlist." >&2
exit 1
