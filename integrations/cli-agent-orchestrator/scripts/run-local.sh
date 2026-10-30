#!/usr/bin/env bash
# Bring up (or tear down) the local CAO side of the AG-UI Dojo tool approval demo:
# a loopback cao-server with AG-UI enabled, plus one Claude Code agent that is
# about to ask permission to write a file.
#
#   scripts/run-local.sh          start the server if needed, install the profile, launch the agent
#   scripts/run-local.sh --down   shut the demo session down, and stop the server if this script started it
#
# Environment:
#   CAO_HOST   default 127.0.0.1 (or localhost). Loopback only: cao-server has no
#              authentication by default.
#   CAO_PORT   default 9889.
#
# Written for bash 3.2, which is what macOS ships.
set -euo pipefail

HOST="${CAO_HOST:-127.0.0.1}"
PORT="${CAO_PORT:-9889}"
SESSION="agui-demo"           # cao prefixes it, so tmux shows "cao-agui-demo"
PROFILE="agui-approver"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_FILE="$SCRIPT_DIR/../agui-approver.md"
TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
STATE_DIR="$TMP_ROOT/cao-agui-demo"
BASE="http://$HOST:$PORT"
DOJO_URL="http://localhost:3000/cli-agent-orchestrator/feature/tool_approval"

# The cao CLI reads the server address from these.
export CAO_API_HOST="$HOST" CAO_API_PORT="$PORT"

die() { echo "run-local: $*" >&2; exit 1; }

case "$HOST" in
  127.0.0.1 | localhost) ;;
  ::1 | "[::1]") die "use CAO_HOST=127.0.0.1: this script builds plain host:port URLs, which do not work for IPv6" ;;
  *) die "refusing CAO_HOST=$HOST: cao-server runs commands for whoever can reach it, so it stays on loopback" ;;
esac

server_up() { curl -fsS -m 2 "$BASE/health" >/dev/null 2>&1; }

# Whether a pid from server.pid is still the cao-server this script started,
# so a recycled pid never gets signalled. cao-server is a Python entry point,
# so `comm` shows the interpreter; the full command line names cao-server.
is_our_server() {
  ps -o command= -p "$1" 2>/dev/null | grep -q 'cao-server'
}

# STATE_DIR sits in a shared temp dir and holds the pid this script kills and
# the path it deletes, so only trust it if it is a real directory we own.
check_state_dir() {
  if [ -L "$STATE_DIR" ]; then die "refusing: $STATE_DIR is a symlink"; fi
  if [ -e "$STATE_DIR" ]; then
    [ -d "$STATE_DIR" ] || die "refusing: $STATE_DIR exists and is not a directory"
    [ -O "$STATE_DIR" ] || die "refusing: $STATE_DIR is not owned by $(id -un)"
  fi
}

# Delete the agent's work dir, but only one this script could have created.
remove_workdir() {
  [ -f "$STATE_DIR/workdir" ] || return 0
  w="$(cat "$STATE_DIR/workdir")"
  case "$w" in
    "$TMP_ROOT"/cao-agui-work.*) ;;
    *) echo "run-local: not deleting unexpected work dir '$w'" >&2; return 0 ;;
  esac
  case "${w#"$TMP_ROOT"/cao-agui-work.}" in
    "" | */* | *..*) echo "run-local: not deleting unexpected work dir '$w'" >&2; return 0 ;;
  esac
  if [ -d "$w" ] && [ ! -L "$w" ]; then rm -rf "$w"; fi
}

down() {
  check_state_dir
  if server_up; then
    cao shutdown --session "cao-$SESSION" >/dev/null 2>&1 || true
  fi
  # If the server was already gone, its tmux session can outlive it.
  tmux kill-session -t "cao-$SESSION" 2>/dev/null || true
  if [ -f "$STATE_DIR/server.pid" ]; then
    pid="$(cat "$STATE_DIR/server.pid")"
    if kill -0 "$pid" 2>/dev/null && ! is_our_server "$pid"; then
      echo "run-local: pid $pid is no longer cao-server; not stopping it" >&2
    elif kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      # Wait for it to exit, so an immediate rerun starts a fresh server
      # instead of finding this one still answering /health.
      i=0
      while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do
        i=$((i + 1))
        sleep 1
      done
      echo "stopped cao-server (pid $pid)"
    fi
  fi
  remove_workdir
  rm -rf "$STATE_DIR"
  echo "demo torn down"
}

if [ "${1:-}" = "--down" ]; then
  down
  exit 0
fi
[ $# -eq 0 ] || die "unknown argument: $1 (use --down to tear down)"

for cmd in cao cao-server tmux claude curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is not on PATH (see the README prerequisites)"
done
[ -f "$PROFILE_FILE" ] || die "profile not found at $PROFILE_FILE"
check_state_dir

# If anything below fails, undo only what this run started.
STARTED_SERVER=0
LAUNCHED=0
OK=0
on_exit() {
  if [ "$OK" -ne 1 ]; then
    echo "run-local: failed, undoing what this run started" >&2
    if [ "$LAUNCHED" -eq 1 ]; then cao shutdown --session "cao-$SESSION" >/dev/null 2>&1 || true; fi
    if [ "$STARTED_SERVER" -eq 1 ] && [ -f "$STATE_DIR/server.pid" ]; then
      pid="$(cat "$STATE_DIR/server.pid")"
      if is_our_server "$pid"; then kill "$pid" 2>/dev/null || true; fi
    fi
    remove_workdir
    rm -rf "$STATE_DIR"
  fi
}
trap on_exit EXIT
trap 'exit 130' INT TERM

mkdir -p "$STATE_DIR"

if server_up; then
  echo "cao-server already running at $BASE"
  echo "warning: reusing that server; its bind address was not checked, so make sure it listens on loopback only" >&2
else
  echo "starting cao-server at $BASE (log: $STATE_DIR/server.log)"
  CAO_AGUI_ENABLED=1 nohup cao-server --host "$HOST" --port "$PORT" >"$STATE_DIR/server.log" 2>&1 &
  echo $! >"$STATE_DIR/server.pid"
  STARTED_SERVER=1
  i=0
  until server_up; do
    i=$((i + 1))
    [ "$i" -le 60 ] || die "cao-server did not answer $BASE/health within 60s; see $STATE_DIR/server.log"
    sleep 1
  done
fi

# Probe the run endpoint: it 404s when the AG-UI surface is off and 501s
# without the [agui] extra. This is a real, harmless run (thread "run-local")
# that collects any pending prompt without answering it. -m 3 caps it, because
# CAO releases before the run-plane fix keep that stream open.
code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' -X POST "$BASE/agui/v1/run" \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"run-local","runId":"probe","state":{},"messages":[],"tools":[],"context":[],"forwardedProps":{}}' || true)"
case "$code" in
  200) ;;
  404) die "AG-UI is disabled on $BASE. Restart cao-server with CAO_AGUI_ENABLED=1" ;;
  501) die "cao-server lacks the [agui] extra. Reinstall cli-agent-orchestrator with [agui]" ;;
  *) die "POST $BASE/agui/v1/run returned '$code'" ;;
esac

cao install "$PROFILE_FILE" >/dev/null
echo "installed profile $PROFILE"

# A fresh temp dir, so the agent's one file write never lands in this repo.
WORKDIR="$(mktemp -d "$TMP_ROOT/cao-agui-work.XXXXXX")"
echo "$WORKDIR" >"$STATE_DIR/workdir"

echo "launching $PROFILE in $WORKDIR (Claude Code takes ~20s to start)"
# --auto-approve only skips cao launch's confirmation prompt. It does not change
# the tool policy: permission prompts still reach the Dojo as approval cards.
cao launch --agents "$PROFILE" --session-name "$SESSION" --working-directory "$WORKDIR" \
  --headless --auto-approve --async "Do your task now." >/dev/null
LAUNCHED=1

OK=1
cat <<EOF

The agent is starting and will stop at a Claude Code permission prompt.

  Dojo page:  $DOJO_URL
  Watch it:   tmux attach -t cao-$SESSION   (detach with Ctrl-b d)
  Tear down:  $0 --down
EOF
