#!/usr/bin/env bash
# Bring up (or tear down) the local CAO side of the AG-UI Dojo tool approval demo:
# its own loopback cao-server with AG-UI enabled, plus one Claude Code agent that
# is about to ask permission to write a file.
#
#   scripts/run-local.sh              start a run; prints its RUN_DIR, CAO_URL and SESSION
#   scripts/run-local.sh --down DIR   stop exactly the server and session that run DIR recorded
#
# Every run owns a fresh temp directory (RUN_DIR) and its own cao-server with its
# own CAO state (CAO_HOME_DIR inside RUN_DIR), so the demo never shares sessions,
# prompts or files with any other CAO. There is no shared lock or state: a second
# run needs another port, and refuses if the port is taken.
#
# Environment:
#   CAO_PORT   default 9898. Loopback only: cao-server has no authentication.
#
# Written for bash 3.2, which is what macOS ships.
set -euo pipefail

PORT="${CAO_PORT:-9898}"
PROFILE="agui-approver"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_FILE="$SCRIPT_DIR/../agui-approver.md"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
START_TIMEOUT="${CAO_START_TIMEOUT:-60}"   # seconds to wait for cao-server /health
STOP_TIMEOUT="${CAO_STOP_TIMEOUT:-30}"     # seconds to wait for cao-server to exit
SHUTDOWN_TIMEOUT="${CAO_SHUTDOWN_TIMEOUT:-10}"   # seconds to give `cao shutdown`
BASE="http://127.0.0.1:$PORT"

die() { echo "run-local: $*" >&2; exit 1; }
server_up() { curl -fsS -m 2 "$BASE/health" >/dev/null 2>&1; }

# The start time of a process, as `ps` prints it. A pid alone can be reused by
# another process, so the run records pid and start time together.
proc_start() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'; }

# Whether pid is the cao-server run dir $2 started: same command, same start time.
is_our_server() {
  ps -o command= -p "$1" 2>/dev/null | grep -q 'cao-server' || return 1
  recorded="$(cat "$2/server.start" 2>/dev/null || true)"
  [ -n "$recorded" ] && [ "$(proc_start "$1")" = "$recorded" ]
}

# Stop exactly what run dir $1 recorded: its tmux session and its server, then
# remove the run dir (which holds the workdir). If the server does not exit in time, keep the run dir (and its pid
# file) and return 1, so the stop can be retried.
stop_run() {
  dir="$1"
  [ -f "$dir/.cao-agui-run" ] && [ ! -L "$dir" ] && [ -O "$dir" ] || die "$dir is not a run directory made by this script"
  session="$(cat "$dir/session" 2>/dev/null || true)"
  if [ -n "$session" ]; then
    # `cao shutdown` has no timeout of its own, so give it a deadline and move
    # on to the exact-session fallback and the bounded server stop either way.
    (CAO_HOME_DIR="$dir/home" CAO_API_HOST=127.0.0.1 CAO_API_PORT="$(cat "$dir/port")" exec cao shutdown --session "cao-$session") >/dev/null 2>&1 &
    sd=$!
    i=0
    while kill -0 "$sd" 2>/dev/null && [ "$i" -lt "$SHUTDOWN_TIMEOUT" ]; do i=$((i + 1)); sleep 1; done
    if kill -0 "$sd" 2>/dev/null; then kill "$sd" 2>/dev/null || true; kill -9 "$sd" 2>/dev/null || true; fi
    wait "$sd" 2>/dev/null || true
    tmux kill-session -t "=cao-$session" 2>/dev/null || true
  fi
  pid="$(cat "$dir/server.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    is_our_server "$pid" "$dir" || die "pid $pid is not the cao-server this run started (different process or start time); not stopping it (run dir $dir kept)"
    kill "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$STOP_TIMEOUT" ]; do i=$((i + 1)); sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      echo "run-local: cao-server (pid $pid) is still running after ${STOP_TIMEOUT}s; kept $dir, run '$0 --down $dir' again" >&2
      return 1
    fi
  fi
  # The agent's work dir lives inside the run dir, so this removes it too.
  rm -rf "$dir"
}

if [ "${1:-}" = "--down" ]; then
  [ $# -eq 2 ] || die "usage: $0 --down RUN_DIR"
  stop_run "$2" || exit 1
  echo "demo torn down"
  exit 0
fi
[ $# -eq 0 ] || die "unknown argument: $1 (use --down RUN_DIR to tear down)"

for cmd in cao cao-server tmux claude curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is not on PATH (see the README prerequisites)"
done
[ -f "$PROFILE_FILE" ] || die "profile not found at $PROFILE_FILE"
case "$PORT" in "" | *[!0-9]*) die "CAO_PORT must be a number" ;; esac

# Refuse a taken port: curl exits 7 when nothing is listening.
rc=0; curl -s -o /dev/null -m 2 "$BASE/" || rc=$?
[ "$rc" -eq 7 ] || die "port $PORT is already in use; stop what is there or set CAO_PORT"

RUN_DIR="$(mktemp -d "$TMP_ROOT/cao-agui-run.XXXXXX")" || die "could not create a run directory"
SESSION="agui-demo-${RUN_DIR##*.}"        # cao prefixes it: tmux shows "cao-agui-demo-<id>"
touch "$RUN_DIR/.cao-agui-run"
echo "$SESSION" >"$RUN_DIR/session"
echo "$PORT" >"$RUN_DIR/port"

# The cao CLI and server read these. CAO_HOME_DIR keeps the demo's profile,
# database and logs inside RUN_DIR.
export CAO_HOME_DIR="$RUN_DIR/home" CAO_API_HOST=127.0.0.1 CAO_API_PORT="$PORT"

# On failure, stop what this run started (bounded, same as --down), keep the
# original error status, and print the server log, which goes with the run dir.
OK=0
on_exit() {
  status=$?
  if [ "$OK" -ne 1 ]; then
    echo "run-local: failed, undoing what this run started" >&2
    if [ -s "$RUN_DIR/server.log" ]; then
      echo "run-local: last lines of the cao-server log:" >&2
      tail -n 20 "$RUN_DIR/server.log" >&2 || true
      # mktemp creates the file exclusively with a random name, so a link
      # planted in the shared temp dir cannot redirect the copy.
      kept="$(mktemp "$TMP_ROOT/cao-agui-server-log.XXXXXX" 2>/dev/null || true)"
      if [ -n "$kept" ] && cp "$RUN_DIR/server.log" "$kept" 2>/dev/null; then
        echo "run-local: full server log kept at $kept" >&2
      fi
    fi
    (stop_run "$RUN_DIR") || true
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

echo "starting cao-server at $BASE (run dir: $RUN_DIR)"
CAO_AGUI_ENABLED=1 nohup cao-server --host 127.0.0.1 --port "$PORT" >"$RUN_DIR/server.log" 2>&1 &
echo $! >"$RUN_DIR/server.pid"
proc_start "$!" >"$RUN_DIR/server.start"
i=0
until server_up && sleep 1 && kill -0 "$(cat "$RUN_DIR/server.pid")" 2>/dev/null; do
  kill -0 "$(cat "$RUN_DIR/server.pid")" 2>/dev/null || die "cao-server exited at startup (port $PORT taken?)"
  i=$((i + 1))
  [ "$i" -le "$START_TIMEOUT" ] || die "cao-server did not answer $BASE/health within ${START_TIMEOUT}s"
  sleep 1
done

# Probe the run endpoint: it 404s when the AG-UI surface is off and 501s
# without the [agui] extra. -m 3 caps it, because CAO releases before the
# run-plane fix keep that stream open.
code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' -X POST "$BASE/agui/v1/run" \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"run-local","runId":"probe","state":{},"messages":[],"tools":[],"context":[],"forwardedProps":{}}' || true)"
case "$code" in
  200) ;;
  404) die "AG-UI is disabled on $BASE" ;;
  501) die "cao-server lacks the [agui] extra. Reinstall cli-agent-orchestrator with [agui]" ;;
  *) die "POST $BASE/agui/v1/run returned '$code'" ;;
esac

cao install "$PROFILE_FILE" >/dev/null
echo "installed profile $PROFILE"

# A fresh directory inside the run dir, so the agent's one file write never
# lands in this repo and teardown removes it with the run, whatever TMPDIR is.
WORKDIR="$RUN_DIR/work"
mkdir -m 700 "$WORKDIR"
echo "$WORKDIR" >"$RUN_DIR/workdir"

echo "launching $PROFILE in $WORKDIR (Claude Code takes ~20s to start)"
# --auto-approve only skips cao launch's confirmation prompt. It does not change
# the tool policy: permission prompts still reach the Dojo as approval cards.
cao launch --agents "$PROFILE" --session-name "$SESSION" --working-directory "$WORKDIR" \
  --headless --auto-approve --async "Do your task now." >/dev/null

OK=1
cat <<EOT

RUN_DIR=$RUN_DIR
CAO_URL=$BASE
SESSION=cao-$SESSION

The agent is starting and will stop at a Claude Code permission prompt.

  Dojo:       cd apps/dojo && CAO_URL=$BASE pnpm dev -H 127.0.0.1
  Dojo page:  http://127.0.0.1:3000/cli-agent-orchestrator/feature/tool_approval
  Watch it:   tmux attach -t cao-$SESSION   (detach with Ctrl-b d)
  Tear down:  $0 --down $RUN_DIR
EOT
