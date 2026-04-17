#!/usr/bin/env bash
# scripts/release/create-tags.sh
#
# Idempotent, retry-safe git tag creation + push for release workflows.
#
# Usage: ./create-tags.sh <packages-json>
#   packages-json: JSON array string of packages to tag
#     Format: [{"name":"<pkg>","version":"<ver>", ...}, ...]
#
# Behavior:
#   - For each package, constructs TAG="<name>@<version>" and creates/pushes it.
#   - If the tag already exists locally or on the remote:
#       * and it points to HEAD, or to an ancestor of HEAD (main advanced since
#         the original run), skip the tag — this is the retry-safe case.
#       * otherwise it is a real collision; record the error but keep going so
#         other packages still get tagged.
#   - Pushes each tag immediately after creating it, so partial success is
#     preserved when the job is retried after e.g. an intermittent push failure.
#   - Appends a step summary row for every tag action when $GITHUB_STEP_SUMMARY
#     is set.
#   - Exits 0 only if all packages were either tagged-and-pushed or legitimately
#     skipped. Exits non-zero if any genuine collision or push failure occurred.
#
# Requires: git, jq. Must be invoked from inside a git working tree whose HEAD
# is the commit to tag.

set -euo pipefail

PACKAGES_JSON="${1:?Usage: $0 <packages-json>}"

# Regex guards for tag components. Names are a superset of npm + PyPI
# (allowing scoped npm names like @ag-ui/core and PyPI names like ag-ui-protocol).
# Versions accept PEP 440 + semver shapes.
NAME_RE='^[A-Za-z0-9._@/-]+$'
VERSION_RE='^[A-Za-z0-9.+_!-]+$'

HEAD_SHA=$(git rev-parse HEAD)

summary() {
  # Append a line to $GITHUB_STEP_SUMMARY if set. No-op otherwise.
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo ""
    echo "### Git tags"
    echo ""
    echo "| Tag | Action | Detail |"
    echo "|-----|--------|--------|"
  } >> "$GITHUB_STEP_SUMMARY"
fi

# Dedupe incoming tags so a repeated (name, version) does not produce
# confusing double-processing in the loop.
PACKAGES_JSON=$(echo "$PACKAGES_JSON" | jq -c '[.[] | {name, version}] | unique_by("\(.name)@\(.version)")' | jq -c '[.[] | {name, version}]' 2>/dev/null || echo "$PACKAGES_JSON")

FAILED=0
COLLISIONS=()

while read -r pkg; do
  NAME=$(echo "$pkg" | jq -r '.name')
  VERSION=$(echo "$pkg" | jq -r '.version')

  if ! [[ "$NAME" =~ $NAME_RE ]]; then
    echo "ERROR: invalid package name '$NAME' — refusing to construct tag" >&2
    summary "| (invalid) | error | invalid name '$NAME' |"
    FAILED=1
    continue
  fi
  if ! [[ "$VERSION" =~ $VERSION_RE ]]; then
    echo "ERROR: invalid version '$VERSION' for $NAME — refusing to construct tag" >&2
    summary "| $NAME | error | invalid version '$VERSION' |"
    FAILED=1
    continue
  fi

  TAG="${NAME}@${VERSION}"

  # Fetch the tag from the remote (may not exist locally after a fresh checkout,
  # or may have been pushed by a prior partial run). Distinguish between
  # "tag does not exist remotely" (expected on first run) and a real
  # auth/network failure (must surface).
  FETCH_LOG=$(mktemp)
  if git fetch origin "refs/tags/${TAG}:refs/tags/${TAG}" 2>"$FETCH_LOG"; then
    :
  else
    # Non-zero exit: either the ref doesn't exist on the remote (fine) or
    # something is actually wrong. "couldn't find remote ref" => benign.
    if grep -qiE "couldn.t find remote ref|does not appear to be a git repository|no such ref" "$FETCH_LOG"; then
      : # expected — tag not on remote yet
    else
      echo "ERROR: git fetch for tag $TAG failed:" >&2
      cat "$FETCH_LOG" >&2
      rm -f "$FETCH_LOG"
      summary "| $TAG | error | fetch failed |"
      FAILED=1
      continue
    fi
  fi
  rm -f "$FETCH_LOG"

  if git rev-parse --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
    EXISTING_SHA=$(git rev-parse "refs/tags/${TAG}^{commit}")
    if [ "$EXISTING_SHA" = "$HEAD_SHA" ]; then
      echo "Tag $TAG already exists at HEAD, skipping"
      summary "| $TAG | skipped | already exists at HEAD |"
      continue
    fi
    if git merge-base --is-ancestor "$EXISTING_SHA" "$HEAD_SHA" 2>/dev/null; then
      echo "Tag $TAG exists at $EXISTING_SHA, which is an ancestor of HEAD ($HEAD_SHA); skipping (likely a retry after main advanced)"
      summary "| $TAG | skipped | ancestor of HEAD ($EXISTING_SHA) |"
      continue
    fi
    echo "ERROR: Tag $TAG exists at $EXISTING_SHA, which is NOT an ancestor of HEAD ($HEAD_SHA): version collision" >&2
    summary "| $TAG | collision | exists at $EXISTING_SHA, not an ancestor of HEAD |"
    COLLISIONS+=("$TAG@$EXISTING_SHA")
    FAILED=1
    continue
  fi

  if ! git tag "$TAG"; then
    echo "ERROR: Failed to create local tag $TAG" >&2
    summary "| $TAG | error | local tag creation failed |"
    FAILED=1
    continue
  fi

  # Push immediately so partial progress is preserved across retries.
  # --atomic is a single-ref no-op here but makes intent explicit and is a
  # belt-and-suspenders guard if callers ever pass multiple refs at once.
  if ! git push --atomic origin "refs/tags/${TAG}"; then
    echo "ERROR: Failed to push tag $TAG" >&2
    summary "| $TAG | error | push failed |"
    FAILED=1
    continue
  fi

  echo "Tagged and pushed $TAG"
  summary "| $TAG | created | pushed to origin |"
done < <(echo "$PACKAGES_JSON" | jq -c '.[]')

if [ ${#COLLISIONS[@]} -gt 0 ]; then
  echo "" >&2
  echo "Tag collisions (tag@existing_sha):" >&2
  printf '  %s\n' "${COLLISIONS[@]}" >&2
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
