#!/usr/bin/env bash
# scripts/release/reconcile-release.sh
#
# Final safety net: ensures a daily GitHub Release exists for today's date and
# contains an entry for every tag we just pushed. Handles the partial-failure
# case where tags were pushed but `gh release create/edit` did not complete.
#
# Usage: ./reconcile-release.sh <ecosystem> <packages-json>
#
# This is idempotent: if the release already has all required rows, it does
# nothing. Otherwise it invokes create-or-update-release.sh to append the
# missing content.

set -euo pipefail

ECOSYSTEM="${1:?Usage: $0 <ecosystem> <packages-json>}"
PACKAGES_JSON="${2:?Usage: $0 <ecosystem> <packages-json>}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG="release/$(date -u +%Y-%m-%d)"

if ! gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG does not exist; creating via create-or-update-release.sh" >&2
  bash "$REPO_ROOT/scripts/release/create-or-update-release.sh" "$ECOSYSTEM" "$PACKAGES_JSON"
  exit $?
fi

BODY=$(gh release view "$TAG" --json body -q .body || true)

MISSING=0
while read -r pkg; do
  NAME=$(echo "$pkg" | jq -r '.name')
  VERSION=$(echo "$pkg" | jq -r '.version')
  if ! grep -Fq "| ${NAME} | ${VERSION} |" <<<"$BODY"; then
    echo "Release $TAG missing row for ${NAME}@${VERSION}" >&2
    MISSING=1
  fi
done < <(echo "$PACKAGES_JSON" | jq -c '.[]')

if [ "$MISSING" -ne 0 ]; then
  echo "Reconciling release $TAG via create-or-update-release.sh" >&2
  bash "$REPO_ROOT/scripts/release/create-or-update-release.sh" "$ECOSYSTEM" "$PACKAGES_JSON"
else
  echo "Release $TAG already has rows for all published packages; nothing to reconcile" >&2
fi
