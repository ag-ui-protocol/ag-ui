#!/usr/bin/env bash
# Local-only end-to-end check of this integration against a real cao-server and
# a real Claude Code agent: approve, then a fresh demo and reject, then a run
# with nothing pending, then two fresh demos where the first answer is dropped (once before it
# reaches CAO, once after) and the same card is answered again. Exits 0 only if every assertion passes. Not wired into
# CI; it needs the README prerequisites and a logged-in `claude`.
#
#   integrations/cli-agent-orchestrator/scripts/e2e-local.sh
#
# Environment:
#   CAO_PORT        default 9898 (passed through to run-local.sh)
#   DOJO_PORT       default 3000
#   E2E_VIDEO_DIR   opt-in: record each phase's page video into this directory
#   E2E_CAPTION     opt-in: caption drawn on the page in those videos
#   E2E_SHOT_DIR    opt-in: save a screenshot of each step into this directory
#
# The Dojo's Playwright and its Chromium must be installed once:
#   (cd apps/dojo/e2e && pnpm install --ignore-scripts && npx playwright install chromium)
#
# Written for bash 3.2, which is what macOS ships.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUN_LOCAL="$SCRIPT_DIR/run-local.sh"
DRIVER="$SCRIPT_DIR/e2e-local.mjs"
CAO_PORT="${CAO_PORT:-9898}"
DOJO_PORT="${DOJO_PORT:-3000}"
CAO_URL="http://127.0.0.1:$CAO_PORT"
DOJO_URL="http://127.0.0.1:$DOJO_PORT"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
RUN_DIR=""
SESSION=""
LOG_DIR="$(mktemp -d "$TMP_ROOT/cao-agui-e2e.XXXXXX")"
PROMPT_TEXT="Do you want to create approved-by-dojo.txt?"
export CAO_PORT

die() { echo "e2e-local: $*" >&2; exit 1; }

for cmd in node pnpm curl tmux; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is not on PATH"
done
PW_INSTALL="(cd apps/dojo/e2e && pnpm install --ignore-scripts && npx playwright install chromium)"
(cd "$REPO_ROOT/apps/dojo/e2e" && node -e 'require.resolve("@playwright/test")') >/dev/null 2>&1 ||
  die "the Dojo's Playwright is not installed: $PW_INSTALL"
(cd "$REPO_ROOT/apps/dojo/e2e" && node -e '
  const { chromium } = require("@playwright/test");
  process.exit(require("fs").existsSync(chromium.executablePath()) ? 0 : 1);
') >/dev/null 2>&1 ||
  die "Playwright's Chromium is not installed: $PW_INSTALL"
if curl -s -o /dev/null -m 2 "$DOJO_URL/"; then
  die "something is already serving $DOJO_URL; stop it or set DOJO_PORT"
fi

DOJO_PID=""
# Stop a process and everything it started (pnpm -> next -> workers).
# shellcheck disable=SC2329 # called from cleanup, which the EXIT trap runs
kill_tree() {
  for child in $(pgrep -P "$1" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$1" 2>/dev/null || true
}
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  status=$?
  down_failed=0
  if [ -n "$RUN_DIR" ]; then
    if ! "$RUN_LOCAL" --down "$RUN_DIR" >"$LOG_DIR/down.log" 2>&1; then
      down_failed=1
      cat "$LOG_DIR/down.log" >&2
      echo "e2e-local: teardown of $RUN_DIR failed; its server may still be running. Retry: $RUN_LOCAL --down $RUN_DIR" >&2
    fi
  fi
  if [ -n "$DOJO_PID" ]; then kill_tree "$DOJO_PID"; fi
  if [ "$status" -eq 0 ] && [ "$down_failed" -eq 0 ]; then
    rm -rf "$LOG_DIR"
  else
    echo "e2e-local: logs kept in $LOG_DIR" >&2
    [ "$status" -ne 0 ] || exit 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== starting the Dojo (loopback only) on $DOJO_URL (log: $LOG_DIR/dojo.log)"
(cd "$REPO_ROOT/apps/dojo" && CAO_URL="$CAO_URL" PORT="$DOJO_PORT" exec pnpm dev -H 127.0.0.1) >"$LOG_DIR/dojo.log" 2>&1 &
DOJO_PID=$!
# The first request compiles the page; wait for it to come back 200 (about 6 minutes at most).
i=0
until [ "$(curl -s -o /dev/null -m 10 -w '%{http_code}' \
  "$DOJO_URL/cli-agent-orchestrator/feature/tool_approval" || true)" = 200 ]; do
  i=$((i + 1))
  [ "$i" -le 30 ] || die "the Dojo did not serve the Tool Approval page; see $LOG_DIR/dojo.log"
  sleep 2
done

# Bring up a fresh demo and wait until the agent's permission prompt is on screen.
fresh_demo() {
  if [ -n "$RUN_DIR" ]; then
    # RUN_DIR stays set if this fails, so the exit cleanup retries it.
    "$RUN_LOCAL" --down "$RUN_DIR" >&2 || die "teardown of the previous demo failed ($RUN_DIR); retry: $RUN_LOCAL --down $RUN_DIR"
    RUN_DIR=""
  fi
  "$RUN_LOCAL" >"$LOG_DIR/run-local.log" 2>&1 || { cat "$LOG_DIR/run-local.log" >&2; die "run-local.sh failed"; }
  RUN_DIR="$(sed -n 's/^RUN_DIR=//p' "$LOG_DIR/run-local.log")"
  SESSION="$(sed -n 's/^SESSION=//p' "$LOG_DIR/run-local.log")"
  [ -n "$RUN_DIR" ] && [ -n "$SESSION" ] || die "run-local.sh did not report its run directory"
  i=0
  until tmux capture-pane -p -t "$SESSION" 2>/dev/null | grep -qF "$PROMPT_TEXT"; do
    i=$((i + 1))
    [ "$i" -le 240 ] || die "the agent never showed its permission prompt within 240s"
    sleep 1
  done
  E2E_WORKDIR="$(cat "$RUN_DIR/workdir")"
  E2E_SESSION="$SESSION"
  export E2E_WORKDIR E2E_SESSION
}

result=0
phase() {
  echo "== $1"
  if ! DOJO_URL="$DOJO_URL" CAO_URL="$CAO_URL" node "$DRIVER" "$1"; then result=1; fi
}

fresh_demo
phase approve
fresh_demo
phase reject
phase none
fresh_demo
phase retry
fresh_demo
phase retry-response

if [ "$result" -eq 0 ]; then echo "e2e-local: PASS"; else echo "e2e-local: FAIL"; fi
exit "$result"
