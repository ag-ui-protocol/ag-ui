#!/usr/bin/env bash
# scripts/release/create-or-update-release.sh
#
# Creates or updates a daily GitHub Release with published package info.
#
# Usage: ./create-or-update-release.sh <ecosystem> <packages-json>
#   ecosystem: "typescript" or "python"
#   packages-json: JSON array string of published packages
#     TS format:  [{"name":"@ag-ui/core","version":"0.0.49","path":"..."}]
#     Py format:  [{"name":"ag-ui-protocol","version":"0.1.15","dir":"..."}]
#
# Requires: gh CLI authenticated with contents:write permission
# Environment: DRY_RUN=true to skip actual release creation

set -euo pipefail

ECOSYSTEM="${1:?Usage: $0 <ecosystem> <packages-json>}"
PACKAGES_JSON="${2:?Usage: $0 <ecosystem> <packages-json>}"

TAG="release/$(date -u +%Y-%m-%d)"
TITLE="Release $(date -u +%Y-%m-%d)"
TIMESTAMP=$(date -u +%H:%M:%S)

# Build the section for this ecosystem using real newlines (not \n literals)
NL=$'\n'
if [ "$ECOSYSTEM" = "typescript" ]; then
  SECTION="### TypeScript (npm) — published at ${TIMESTAMP} UTC${NL}"
  SECTION+="| Package | Version | Install |${NL}"
  SECTION+="|---------|---------|--------|${NL}"
  while read -r pkg; do
    NAME=$(echo "$pkg" | jq -r '.name')
    VERSION=$(echo "$pkg" | jq -r '.version')
    SECTION+="| ${NAME} | ${VERSION} | \`npm install ${NAME}@${VERSION}\` |${NL}"
  done < <(echo "$PACKAGES_JSON" | jq -c '.[]')
elif [ "$ECOSYSTEM" = "python" ]; then
  SECTION="### Python (PyPI) — published at ${TIMESTAMP} UTC${NL}"
  SECTION+="| Package | Version | Install |${NL}"
  SECTION+="|---------|---------|--------|${NL}"
  while read -r pkg; do
    NAME=$(echo "$pkg" | jq -r '.name')
    VERSION=$(echo "$pkg" | jq -r '.version')
    SECTION+="| ${NAME} | ${VERSION} | \`pip install ${NAME}==${VERSION}\` |${NL}"
  done < <(echo "$PACKAGES_JSON" | jq -c '.[]')
else
  echo "ERROR: Unknown ecosystem '$ECOSYSTEM'. Use 'typescript' or 'python'." >&2
  exit 1
fi

NEW_SECTION="${NL}${SECTION}"

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "DRY RUN: Would create/update release $TAG with:" >&2
  echo "$NEW_SECTION" >&2
  exit 0
fi

# Try to get existing release — retry logic for race condition
MAX_RETRIES=3
for i in $(seq 1 $MAX_RETRIES); do
  if gh release view "$TAG" &>/dev/null; then
    # Release exists — append our section
    EXISTING_BODY=$(gh release view "$TAG" --json body -q .body)
    UPDATED_BODY="${EXISTING_BODY}${NEW_SECTION}"
    echo "$UPDATED_BODY" | gh release edit "$TAG" --notes-file -
    echo "Updated existing release $TAG with $ECOSYSTEM packages" >&2
    exit 0
  else
    # Try to create new release
    BODY="## Packages Published${NEW_SECTION}"
    CREATE_OUTPUT=$(echo "$BODY" | gh release create "$TAG" --title "$TITLE" --notes-file - 2>&1) && {
      echo "Created new release $TAG with $ECOSYSTEM packages" >&2
      exit 0
    }
    if echo "$CREATE_OUTPUT" | grep -qi "already exists"; then
      echo "Race condition on release creation (attempt $i/$MAX_RETRIES), retrying..." >&2
      sleep 2
    else
      echo "ERROR: gh release create failed: $CREATE_OUTPUT" >&2
      exit 1
    fi
  fi
done

echo "ERROR: Failed to create or update release after $MAX_RETRIES attempts" >&2
exit 1
