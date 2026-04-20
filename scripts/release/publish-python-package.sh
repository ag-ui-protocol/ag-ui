#!/usr/bin/env bash
# scripts/release/publish-python-package.sh
#
# Builds, tests, and publishes a single Python package to PyPI.
# Extracted from release-python.yml for reuse across workflows.
#
# Usage: ./publish-python-package.sh <dir> <build_system> [--dry-run]
#   dir:          Path to the package directory (e.g., "integrations/langgraph/python")
#   build_system: "uv" or "poetry"
#   --dry-run:    Build and test but skip publishing
#
# Environment:
#   UV_PUBLISH_TOKEN  - PyPI API token (required unless --dry-run)

set -euo pipefail

DIR="${1:?Usage: $0 <dir> <build_system> [--dry-run]}"
BUILD_SYSTEM="${2:?Usage: $0 <dir> <build_system> [--dry-run]}"
DRY_RUN="${3:-}"

# Extract package name and version from pyproject.toml
NAME=$(python3 -c "
import sys, tomllib
cfg = tomllib.load(open(sys.argv[1], 'rb'))
name = cfg.get('project', {}).get('name') or cfg.get('tool', {}).get('poetry', {}).get('name', '')
print(name)
" "$DIR/pyproject.toml")
VERSION=$(python3 -c "
import sys, tomllib
cfg = tomllib.load(open(sys.argv[1], 'rb'))
ver = cfg.get('project', {}).get('version') or cfg.get('tool', {}).get('poetry', {}).get('version', '')
print(ver)
" "$DIR/pyproject.toml")

if [ -z "$NAME" ] || [ -z "$VERSION" ]; then
  echo "ERROR: Could not extract name or version from $DIR/pyproject.toml" >&2
  echo "  NAME='$NAME' VERSION='$VERSION'" >&2
  exit 1
fi

echo "=== Processing ${NAME}@${VERSION} (${BUILD_SYSTEM}) in ${DIR} ==="

cd "${DIR}"

# Install dependencies
if [ "$BUILD_SYSTEM" = "poetry" ]; then
  echo "Installing dependencies with poetry..."
  poetry install
else
  echo "Installing dependencies with uv..."
  uv sync
fi

# Run tests if configured
TEST_CMD=$(python3 -c "
import tomllib, sys
try:
    cfg = tomllib.load(open('pyproject.toml', 'rb'))
    cmd = cfg['tool']['ag-ui']['scripts']['test']
    print(cmd)
except KeyError:
    print('')
except Exception as e:
    print(f'ERROR: Failed to parse pyproject.toml: {e}', file=sys.stderr)
    sys.exit(1)
")

if [ -n "$TEST_CMD" ]; then
  echo "Running tests: $TEST_CMD"
  if [ "$BUILD_SYSTEM" = "poetry" ]; then
    poetry run $TEST_CMD
  else
    uv run $TEST_CMD
  fi
else
  echo "WARNING: No test script configured in [tool.ag-ui.scripts] for ${NAME} — skipping tests" >&2
fi

# Build
echo "Building ${NAME}..."
rm -rf dist/

if [ "$BUILD_SYSTEM" = "poetry" ]; then
  poetry build
else
  uv build
fi

# Verify wheel permissions
python3 -c "
import zipfile, glob, sys
whls = glob.glob('dist/*.whl')
if not whls:
    print('ERROR: No .whl file found in dist/ — build may have failed', file=sys.stderr)
    sys.exit(1)
whl = whls[0]
print(f'Checking {whl}')
bad = []
for info in zipfile.ZipFile(whl).infolist():
    perms = (info.external_attr >> 16) & 0o777
    readable = perms & 0o444
    if not readable:
        bad.append(info.filename)
if bad:
    print(f'ERROR: {len(bad)} file(s) missing read permissions:', file=sys.stderr)
    for f in bad:
        print(f'  - {f}', file=sys.stderr)
    sys.exit(1)
print('All files have correct permissions.')
"

# Publish
if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "DRY RUN: Would publish ${NAME}@${VERSION} to PyPI"
else
  echo "Publishing ${NAME}@${VERSION} to PyPI..."
  uv publish
  echo "Published ${NAME}@${VERSION}"
fi
