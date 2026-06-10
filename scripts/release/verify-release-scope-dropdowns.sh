#!/usr/bin/env bash
# scripts/release/verify-release-scope-dropdowns.sh
#
# Verifies that the hand-maintained `workflow_dispatch` `scope` choice
# dropdowns in the release workflows match the authoritative set of release
# scopes declared in scripts/release/release.config.json (`.scopes` keys).
#
# Why this matters: the release workflows expose a `scope` input as a
# `type: choice` with a hard-coded `options:` list. That list is supposed to
# be "regenerated from release.config.json", but nothing enforced it — so as
# packages were enrolled/renamed in release.config.json the dropdowns drifted
# (newly-enrolled packages weren't canary-selectable; stale scopes lingered).
# This guard fails CI whenever a dropdown diverges from the config.
#
# Two files are checked:
#   .github/workflows/publish-release.yml  — canary/prerelease `scope` input
#   .github/workflows/prepare-release.yml  — create-pr `scope` input
#
# Sentinel exception: neither workflow uses a non-scope sentinel option (no
# `all` / `canary` pseudo-scope — an empty/omitted scope is handled outside
# the options list). If a sentinel is ever introduced, add it to
# SENTINELS below so it is excluded from the equality check.
#
# THIRD scope projection guarded here: publish-release.yml's `notify` job has a
# `Compute release intent` step whose `case "$SCOPE"` maps a dispatch scope to
# its ecosystem (PyPI vs npm) for FAILURE paging. That step runs before
# checkout, so it cannot read release.config.json at runtime and instead carries
# a static list of the python scopes that do NOT end in `-py`. check_notify_case
# below asserts that list (and the `*-py` glob) projects every config scope to
# the correct ecosystem, so this hand-maintained list cannot drift.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$REPO_ROOT/scripts/release/release.config.json"
PUBLISH_WF="$REPO_ROOT/.github/workflows/publish-release.yml"
PREPARE_WF="$REPO_ROOT/.github/workflows/prepare-release.yml"

# Documented non-scope sentinel options to ignore (none today). Space-separated.
SENTINELS=""

for f in "$CONFIG" "$PUBLISH_WF" "$PREPARE_WF"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found" >&2
    exit 1
  fi
done

# Authoritative scope set from release.config.json.
CONFIG_SCOPES=$(jq -r '.scopes | keys[]' "$CONFIG" | sort -u)

# Extract the `options:` list belonging to the `scope:` input from a workflow.
# Uses yq when available (the CI path on ubuntu-latest), otherwise a robust awk
# pass (the local-dev fallback):
#   - find the `scope:` input key (an `inputs:` child, indented 6 spaces),
#   - within that block find its `options:` line,
#   - collect the `- value` list items until indentation drops back out.
#
# yq path: the `on` key is quoted as .["on"] so it is read as the literal map
# key and never YAML-1.1-boolean-coerced (`on`/`off`/`yes`/`no` → true/false).
# The result is emitted on stdout; callers MUST treat zero options as a PARSER
# failure (loud), distinct from a real drift mismatch — see check_workflow.
extract_scope_options() {
  local file="$1"
  if command -v yq >/dev/null 2>&1; then
    yq -r '.["on"].workflow_dispatch.inputs.scope.options[]' "$file" | sort -u
    return
  fi
  awk '
    # Match the scope input key: "      scope:" (6-space indent under inputs:).
    /^      scope:[[:space:]]*$/ { in_scope = 1; next }
    in_scope && /^      [a-zA-Z0-9_-]+:[[:space:]]*$/ { in_scope = 0 }   # next sibling input
    in_scope && /^        options:[[:space:]]*$/ { in_opts = 1; next }
    in_opts {
      # An options list item: "          - value"
      if (match($0, /^[[:space:]]*-[[:space:]]+/)) {
        val = $0
        sub(/^[[:space:]]*-[[:space:]]+/, "", val)
        sub(/[[:space:]]+$/, "", val)
        print val
        next
      }
      # Any non-list-item line ends the options block.
      in_opts = 0
      in_scope = 0
    }
  ' "$file" | sort -u
}

# Strip documented sentinels from an option set before comparing.
strip_sentinels() {
  local opts="$1"
  if [ -z "$SENTINELS" ]; then
    printf '%s\n' "$opts"
    return
  fi
  local filtered="$opts"
  for s in $SENTINELS; do
    filtered=$(printf '%s\n' "$filtered" | grep -vx "$s" || true)
  done
  printf '%s\n' "$filtered"
}

check_workflow() {
  local name="$1" file="$2"
  local opts
  opts=$(extract_scope_options "$file")
  opts=$(strip_sentinels "$opts")

  # Zero options means the PARSER could not locate the scope options block (a
  # yq/awk extraction failure or a structural change to the workflow), NOT that
  # the dropdown drifted. Fail LOUD and distinctly so this is never mistaken for
  # a real drift mismatch (which prints a diff below).
  if [ -z "$opts" ]; then
    echo "ERROR: parser could not find scope options in $file ($name)." >&2
    echo "       Extracted ZERO options via $(command -v yq >/dev/null 2>&1 && echo yq || echo 'awk fallback')." >&2
    echo "       This is a PARSER failure (not a drift mismatch): the 'scope' input's" >&2
    echo "       'options:' list could not be located. Check the workflow structure or" >&2
    echo "       the extractor in this script." >&2
    return 1
  fi

  if [ "$opts" = "$CONFIG_SCOPES" ]; then
    echo "OK: $name scope dropdown matches release.config.json scopes"
    return 0
  fi

  echo "ERROR: $name scope dropdown is out of sync with release.config.json." >&2
  echo "" >&2
  echo "--- diff (release.config.json scopes  vs  $name options) ---" >&2
  diff <(printf '%s\n' "$CONFIG_SCOPES") <(printf '%s\n' "$opts") >&2 || true
  echo "" >&2
  echo "Fix: update the 'scope' input 'options:' list in $file to exactly match" >&2
  echo "the keys of '.scopes' in scripts/release/release.config.json" >&2
  echo "(plus any documented sentinel listed in SENTINELS within this script)." >&2
  return 1
}

# Verify the notify-job ecosystem projection in publish-release.yml's
# `Compute release intent` step. That step's `case "$SCOPE"` maps a scope to its
# ecosystem (PyPI vs npm) for FAILURE paging using a static list of python
# scopes that do NOT end in `-py`, plus a `*-py` glob; everything else is npm.
# Because the step runs before checkout it cannot consult release.config.json at
# runtime, so this guard asserts the static projection still matches config:
#   (1) the explicit list extracted from the case == the config's set of python
#       scopes that do not end in `-py`, AND
#   (2) the full projection (explicit-list OR `*-py` glob → python; else npm)
#       maps EVERY config scope to its real ecosystem (catches e.g. a typescript
#       scope that happens to end in `-py`, or a python scope missing from both).
check_notify_case() {
  local file="$1"
  local ecosystem scope

  # ecosystem-per-scope from config: "<scope> <ecosystem>" lines. A scope is
  # python iff ANY of its packages is python (matches the workflow's intent:
  # any python package in the scope should page the PyPI lane on failure).
  local config_eco
  config_eco=$(jq -r '
    .scopes | to_entries[]
    | .key as $s
    | (if any(.value.packages[]; .ecosystem == "python") then "python" else "typescript" end)
    | "\($s) \(.)"
  ' "$CONFIG" | sort)

  # EXPECTED explicit list: python scopes whose name does NOT end in -py.
  local expected_explicit
  expected_explicit=$(printf '%s\n' "$config_eco" \
    | awk '$2 == "python" && $1 !~ /-py$/ { print $1 }' | sort -u)

  # ACTUAL explicit list from the case: the alternation arm immediately
  # preceding `PY_INTENDED=true` that is NOT the `*-py` glob arm. Pull the
  # `a|b|c)` pattern line and split on `|`, stripping the trailing `)`.
  local actual_explicit
  actual_explicit=$(awk '
    /case[[:space:]]+"\$SCOPE"[[:space:]]+in/ { in_case = 1; next }
    in_case && /esac/ { in_case = 0 }
    in_case && /\|.*\)[[:space:]]*$/ && !/\*-py/ {
      line = $0
      sub(/[[:space:]]*\)[[:space:]]*$/, "", line)   # drop trailing ")"
      sub(/^[[:space:]]+/, "", line)                 # drop leading indent
      n = split(line, arr, "|")
      for (i = 1; i <= n; i++) print arr[i]
    }
  ' "$file" | sort -u)

  local rc_local=0

  if [ "$actual_explicit" != "$expected_explicit" ]; then
    echo "ERROR: publish-release.yml notify-job ecosystem case is out of sync with release.config.json." >&2
    echo "" >&2
    echo "--- diff (expected non-'-py' python scopes  vs  case explicit list) ---" >&2
    diff <(printf '%s\n' "$expected_explicit") <(printf '%s\n' "$actual_explicit") >&2 || true
    echo "" >&2
    echo "Fix: update the explicit python-scope alternation in the 'Compute release" >&2
    echo "intent' step's case to exactly the config python scopes NOT ending in '-py'." >&2
    rc_local=1
  fi

  # Independently validate the full projection against config, so a scope that
  # is mapped to the WRONG lane (e.g. a typescript scope ending in -py, or a
  # python scope absent from BOTH the list and the -py glob) is caught even if
  # the explicit list itself happens to match.
  local projection_mismatch=""
  while read -r scope ecosystem; do
    [ -z "$scope" ] && continue
    local projected="typescript"
    case "$scope" in
      *-py) projected="python" ;;
      *)
        if printf '%s\n' "$actual_explicit" | grep -qx "$scope"; then
          projected="python"
        fi
        ;;
    esac
    if [ "$projected" != "$ecosystem" ]; then
      projection_mismatch+="  $scope: case projects '$projected' but config says '$ecosystem'"$'\n'
    fi
  done <<< "$config_eco"

  if [ -n "$projection_mismatch" ]; then
    echo "ERROR: publish-release.yml notify-job ecosystem case mis-projects scope(s):" >&2
    printf '%s' "$projection_mismatch" >&2
    echo "Fix: the case (explicit list + '*-py' glob) must map every release.config.json" >&2
    echo "scope to its real ecosystem." >&2
    rc_local=1
  fi

  if [ "$rc_local" -eq 0 ]; then
    echo "OK: publish-release.yml notify-job ecosystem case matches release.config.json"
  fi
  return "$rc_local"
}

rc=0
check_workflow "publish-release.yml" "$PUBLISH_WF" || rc=1
check_workflow "prepare-release.yml" "$PREPARE_WF" || rc=1
check_notify_case "$PUBLISH_WF" || rc=1

if [ "$rc" -ne 0 ]; then
  exit 1
fi

echo "OK: both release scope dropdowns match release.config.json; notify-job ecosystem case matches too"
exit 0
