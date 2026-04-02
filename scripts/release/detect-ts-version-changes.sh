#!/usr/bin/env bash
# scripts/release/detect-ts-version-changes.sh
#
# Discovers publishable TypeScript packages from the pnpm workspace,
# compares each version against npm, and outputs a JSON array of
# packages that need publishing.
#
# Output format (stdout): [{"name":"@ag-ui/core","version":"0.0.49","path":"sdks/typescript/packages/core"}, ...]
# Logs go to stderr so they don't corrupt the JSON output.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Get all workspace packages as JSON
PACKAGES=$(cd "$REPO_ROOT" && pnpm list -r --json) || { echo "ERROR: pnpm list failed" >&2; exit 1; }
if [ -z "$PACKAGES" ] || [ "$PACKAGES" = "[]" ]; then
  echo "ERROR: pnpm list returned no packages" >&2; exit 1
fi

# Iterate over each package using process substitution to avoid subshell
RESULTS=()
while read -r pkg; do
  NAME=$(echo "$pkg" | jq -r '.name')
  VERSION=$(echo "$pkg" | jq -r '.version')
  PKG_PATH=$(echo "$pkg" | jq -r '.path')
  RELATIVE_PATH="${PKG_PATH#$REPO_ROOT/}"
  PRIVATE=$(echo "$pkg" | jq -r '.private // false')

  # Skip private packages
  if [ "$PRIVATE" = "true" ]; then
    echo "SKIP (private): $NAME" >&2
    continue
  fi

  # Skip apps/* packages (examples/demos, not publishable libraries)
  if [[ "$RELATIVE_PATH" == apps/* ]]; then
    echo "SKIP (app): $NAME" >&2
    continue
  fi

  # Skip mastra examples
  if [[ "$RELATIVE_PATH" == *examples* ]]; then
    echo "SKIP (example): $NAME" >&2
    continue
  fi

  # Query npm for the published version
  if PUBLISHED_VERSION=$(npm view "$NAME" version 2>/dev/null); then
    # Package exists on npm, compare versions using env vars to avoid shell injection
    IS_NEWER=$(VERSION="$VERSION" PUBLISHED="$PUBLISHED_VERSION" node -e "
      const local = process.env.VERSION.split(/[-+]/)[0].split('.').map(Number);
      const pub = process.env.PUBLISHED.split(/[-+]/)[0].split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((local[i]||0) > (pub[i]||0)) { console.log('true'); process.exit(); }
        if ((local[i]||0) < (pub[i]||0)) { console.log('false'); process.exit(); }
      }
      // Same base version: only upgrade if local is stable and published is prerelease
      const localPre = process.env.VERSION.includes('-');
      const pubPre = process.env.PUBLISHED.includes('-');
      if (!localPre && pubPre) { console.log('true'); } // stable replaces prerelease
      else { console.log('false'); } // same base, don't compare prerelease ordering
    ") || { echo "ERROR: version comparison failed for $NAME" >&2; exit 1; }

    if [ "$IS_NEWER" = "true" ]; then
      echo "CHANGED: $NAME $PUBLISHED_VERSION -> $VERSION at $RELATIVE_PATH" >&2
      RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg p "$RELATIVE_PATH" '{name:$n,version:$v,path:$p}')")
    else
      echo "UP-TO-DATE: $NAME@$VERSION (published: $PUBLISHED_VERSION)" >&2
    fi
  else
    # Package not on npm (404 or error) - treat as new
    echo "NEW (unpublished): $NAME@$VERSION at $RELATIVE_PATH" >&2
    RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg p "$RELATIVE_PATH" '{name:$n,version:$v,path:$p}')")
  fi
done < <(echo "$PACKAGES" | jq -c '.[]')

# Output results
if [ ${#RESULTS[@]} -eq 0 ]; then
  echo '[]'
else
  printf '%s\n' "${RESULTS[@]}" | jq -sc '.'
fi
