#!/usr/bin/env bash
# scripts/release/detect-py-version-changes.sh
#
# Reads scripts/release/python-packages.json, extracts name and version
# from each package's pyproject.toml (uv or poetry format), compares
# against PyPI, and outputs a JSON array of packages that need publishing.
#
# Output format (stdout): [{"name":"ag-ui-protocol","version":"0.1.15","dir":"sdks/python","build_system":"uv"}, ...]
# Logs go to stderr.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="$REPO_ROOT/scripts/release/python-packages.json"

if [ ! -f "$REGISTRY" ]; then
  echo "ERROR: $REGISTRY not found" >&2
  exit 1
fi

RESULTS=()
while read -r entry; do
  DIR=$(echo "$entry" | jq -r '.dir')
  BUILD_SYSTEM=$(echo "$entry" | jq -r '.build_system')
  PYPROJECT="$REPO_ROOT/$DIR/pyproject.toml"

  if [ ! -f "$PYPROJECT" ]; then
    echo "SKIP (no pyproject.toml): $DIR" >&2
    continue
  fi

  # Extract name and version in a single python3 call using env vars
  read -r NAME VERSION < <(PYPROJECT_PATH="$PYPROJECT" BUILD_SYSTEM="$BUILD_SYSTEM" python3 -c "
import os
try:
    import tomllib
except ImportError:
    import tomli as tomllib
with open(os.environ['PYPROJECT_PATH'], 'rb') as f:
    cfg = tomllib.load(f)
bs = os.environ['BUILD_SYSTEM']
if bs == 'poetry':
    sec = cfg['tool']['poetry']
else:
    sec = cfg['project']
print(sec['name'], sec['version'])
") || true

  if [ -z "$NAME" ] || [ -z "$VERSION" ]; then
    echo "SKIP (could not extract name/version): $DIR" >&2
    continue
  fi

  # Query PyPI JSON API for the published version
  PYPI_RESPONSE=$(curl -s --max-time 30 "https://pypi.org/pypi/$NAME/json" || echo "")

  if [ -z "$PYPI_RESPONSE" ] || echo "$PYPI_RESPONSE" | jq -e '.message' &>/dev/null; then
    echo "NEW (unpublished): $NAME@$VERSION at $DIR" >&2
    RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg d "$DIR" --arg b "$BUILD_SYSTEM" '{name:$n,version:$v,dir:$d,build_system:$b}')")
  else
    PUBLISHED_VERSION=$(echo "$PYPI_RESPONSE" | jq -r '.info.version')

    # Compare versions using Python's packaging library with env vars
    IS_NEWER=$(VERSION="$VERSION" PUBLISHED="$PUBLISHED_VERSION" python3 -c "
import os
from packaging.version import Version
try:
    local = Version(os.environ['VERSION'])
    published = Version(os.environ['PUBLISHED'])
    print('true' if local > published else 'false')
except Exception as e:
    print(f'ERROR: {e}', file=__import__('sys').stderr)
    __import__('sys').exit(1)
") || { echo "ERROR: version comparison failed for $NAME" >&2; exit 1; }

    if [ "$IS_NEWER" = "true" ]; then
      echo "CHANGED: $NAME $PUBLISHED_VERSION -> $VERSION at $DIR" >&2
      RESULTS+=("$(jq -n --arg n "$NAME" --arg v "$VERSION" --arg d "$DIR" --arg b "$BUILD_SYSTEM" '{name:$n,version:$v,dir:$d,build_system:$b}')")
    else
      echo "UP-TO-DATE: $NAME@$VERSION (published: $PUBLISHED_VERSION)" >&2
    fi
  fi
done < <(jq -c '.[]' "$REGISTRY")

# Output results
if [ ${#RESULTS[@]} -eq 0 ]; then
  echo '[]'
else
  printf '%s\n' "${RESULTS[@]}" | jq -sc '.'
fi
