#!/usr/bin/env bash
# Tests for run-local.sh against stub cao/cao-server/tmux/claude/curl. No network,
# no real agent. Run it directly:
#
#   integrations/cli-agent-orchestrator/scripts/run-local.test.sh
#
# Nothing here waits on timing: run-local.sh returns only after its server is
# up, so every check starts from a settled state.
#
# Written for bash 3.2, which is what macOS ships.
# shellcheck disable=SC2016 # stub bodies are deliberately single-quoted
set -u

# The scenarios name their ports; a CAO_PORT in the caller's environment must
# not change them. Each command below sets the one it needs (9898 or 9899).
unset CAO_PORT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_LOCAL="$SCRIPT_DIR/run-local.sh"
# Stop here if the fixture cannot be made: ROOT is what the EXIT trap deletes.
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/run-local-test.XXXXXX")" || { echo "cannot create a fixture directory" >&2; exit 1; }
[ -n "$ROOT" ] && [ -d "$ROOT" ] || { echo "no fixture directory" >&2; exit 1; }
ROOT="$(cd "$ROOT" && pwd -P)" || exit 1
STUBS="$ROOT/bin"
export TMPDIR="$ROOT/tmp"
mkdir -p "$STUBS" "$TMPDIR" || exit 1
export PATH="$STUBS:$PATH"
FAILS=0
# Every stub server records its pid here, outside TMPDIR, so no reset of the
# run directories (world) can lose track of one that ignored its stop.
STUB_PIDS="$ROOT/stub-pids"
export STUB_PIDS
: >"$STUB_PIDS"
# Whether a pid is gone. `kill -0` also succeeds for a zombie (a killed process
# whose parent has not reaped it yet), which is not running, so a pid with no
# `ps` state, or a state starting with Z, counts as gone.
pid_gone() {
  state="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"
  [ -z "$state" ] || [ "${state#Z}" != "$state" ]
}
# Wait, bounded (5 s in 0.1 s steps), until a pid is gone.
wait_gone() {
  n=0
  while ! pid_gone "$1" && [ "$n" -lt 50 ]; do n=$((n + 1)); sleep 0.1; done
  pid_gone "$1"
}
# A process start time, as run-local.sh reads one for the server it records.
proc_start() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'; }
# Stop every registered stub server, by pid only, never by pattern, and wait
# for each to be gone: SIGKILL is not instant. Each entry is "<pid> <start
# time>". A pid is signalled only if it is alive and its current start time
# equals the recorded one, so an entry whose process already exited, and whose
# pid may now belong to something else, is skipped.
reap_stubs() {
  while read -r p started; do
    [ -n "$p" ] || continue
    if pid_gone "$p"; then continue; fi
    if [ -z "$started" ] || [ "$(proc_start "$p")" != "$started" ]; then
      echo "run-local.test: pid $p is not ours, left alone" >&2
      continue
    fi
    kill -9 "$p" 2>/dev/null
    wait_gone "$p" || echo "run-local.test: stub $p did not exit" >&2
  done <"$STUB_PIDS"
  : >"$STUB_PIDS"
}
cleanup() {
  reap_stubs
  rm -rf "$ROOT"
}
trap cleanup EXIT

check() { # check <description> <command...>
  desc="$1"; shift
  if "$@"; then echo "PASS $desc"; else echo "FAIL $desc"; FAILS=$((FAILS + 1)); fi
}
stub() { printf '#!/bin/sh\n%s\n' "$2" >"$STUBS/$1"; chmod +x "$STUBS/$1"; }
field() { sed -n "s/^$1=//p" "$2" | head -n 1; }

# A world where a "server" is a file named for its port. cao-server creates it
# and removes it on SIGTERM (unless it is told to ignore the stop); curl reports
# "connection refused" (7) for a port with no such file.
world() {
  reap_stubs
  rm -rf "${TMPDIR:?}"/* ; : >"$TMPDIR/cao.calls"; : >"$TMPDIR/tmux.calls"
  # launch registers the run's tmux session, plus "<session>-backup", a session
  # whose name merely starts with the run's.
  stub cao 'echo "$1 home=$CAO_HOME_DIR port=$CAO_API_PORT host=$CAO_API_HOST $*" >>"$TMPDIR/cao.calls"
[ "$1" = shutdown ] && [ -n "$STUB_SHUTDOWN_HANGS" ] && exec sleep 300
case "$1" in
  install) exit "${STUB_INSTALL_STATUS:-0}";;
  launch) name=""; prev=""; for a in "$@"; do [ "$prev" = --session-name ] && name="cao-$a"; prev="$a"; done
    printf "%s\n%s-backup\n" "$name" "$name" >>"$TMPDIR/tmux.sessions"; exit "${STUB_LAUNCH_STATUS:-0}";;
esac; exit 0'
  stub cao-server 'port=""; while [ $# -gt 0 ]; do [ "$1" = --port ] && port="$2"; shift; done
f="$TMPDIR/port.$port"
[ -n "$STUB_SERVER_FAILS" ] && { echo "boom: cannot bind" >&2; exit 1; }
[ -e "$f" ] && exit 1
touch "$f"
echo "$$ $(ps -o lstart= -p $$ | sed "s/^ *//; s/ *$//")" >>"$STUB_PIDS"
if [ -n "$STUB_IGNORE_STOP" ]; then trap "" TERM; else trap "rm -f \"$f\"; exit 0" TERM; fi
while :; do sleep 1 & wait $!; done'
  # tmux models session matching: "=name" is exact; a bare name is an exact
  # match, else a unique prefix match, else it fails. kill-session removes the
  # session it matched.
  stub tmux 'echo "$@" >>"$TMPDIR/tmux.calls"
cmd="$1"; t=""; while [ $# -gt 0 ]; do [ "$1" = "-t" ] && t="$2"; shift; done
S="$TMPDIR/tmux.sessions"
[ -f "$S" ] || exit 1
case "$t" in
  =*) m="${t#=}"; grep -Fxq -- "$m" "$S" || exit 1;;
  *) if grep -Fxq -- "$t" "$S"; then m="$t"
     else [ "$(grep -c "^$t" "$S")" = 1 ] || exit 1; m="$(grep "^$t" "$S")"; fi;;
esac
if [ "$cmd" = kill-session ]; then grep -Fxv -- "$m" "$S" >"$S.new"; mv "$S.new" "$S"; fi
exit 0'
  stub claude 'exit 0'
  stub curl 'url=""; for a in "$@"; do case "$a" in http://*) url="$a";; esac; done
port="${url#http://127.0.0.1:}"; port="${port%%/*}"
[ -e "$TMPDIR/port.$port" ] || exit 7
case "$*" in *http_code*) printf 200;; esac
exit 0'
  unset STUB_SHUTDOWN_HANGS STUB_SERVER_FAILS STUB_IGNORE_STOP STUB_INSTALL_STATUS STUB_LAUNCH_STATUS
}
rundirs() { find "$TMPDIR" -maxdepth 1 -name "cao-agui-run.*"; }
# The permission bits of a file, on GNU and BSD stat. Separate assignments, so
# the first command's output can never be mixed into the second's. GNU stat
# reads `-f` as "filesystem status", so GNU's -c is tried first.
file_mode() {
  m="$(stat -c %a "$1" 2>/dev/null)" || m="$(stat -f %Lp "$1")"
  printf '%s' "$m"
}
server_alive() { kill -0 "$(cat "$1/server.pid")" 2>/dev/null; }

echo "== a run owns its directory, port and CAO state"
world
CAO_PORT=9898 "$RUN_LOCAL" >"$ROOT/a.out" 2>&1; ra=$?
A_DIR="$(field RUN_DIR "$ROOT/a.out")"; A_SESSION="$(field SESSION "$ROOT/a.out")"
check "the run succeeded" test "$ra" -eq 0
check "it reports RUN_DIR, CAO_URL and SESSION" test -d "$A_DIR" -a "$(field CAO_URL "$ROOT/a.out")" = "http://127.0.0.1:9898" -a -n "$A_SESSION"
check "install ran against the run's own CAO home and port" grep -q "^install home=$A_DIR/home port=9898" "$TMPDIR/cao.calls"
check "launch ran against the run's own CAO home and port" grep -q "^launch home=$A_DIR/home port=9898" "$TMPDIR/cao.calls"
check "the session name is unique to the run" test "$A_SESSION" != "cao-agui-demo"

echo "== a second run on the taken port refuses and leaves the first alone"
CAO_PORT=9898 "$RUN_LOCAL" >"$ROOT/b.out" 2>&1; rb=$?
check "the second run refused" test "$rb" -ne 0
check "it says the port is in use" grep -q "port 9898 is already in use" "$ROOT/b.out"
check "the first run is untouched" server_alive "$A_DIR"
check "no second run directory was made" test "$(rundirs | wc -l | tr -d ' ')" = 1

echo "== two runs on different ports; --down stops only its own"
CAO_PORT=9899 "$RUN_LOCAL" >"$ROOT/c.out" 2>&1; rc=$?
C_DIR="$(field RUN_DIR "$ROOT/c.out")"; C_SESSION="$(field SESSION "$ROOT/c.out")"
check "the second run on its own port succeeded" test "$rc" -eq 0
check "the runs have different directories and sessions" test "$A_DIR" != "$C_DIR" -a "$A_SESSION" != "$C_SESSION"
: >"$TMPDIR/tmux.calls"
"$RUN_LOCAL" --down "$A_DIR" >"$ROOT/d.out" 2>&1; rd=$?
check "--down of the first run succeeded" test "$rd" -eq 0
check "the first run's directory and server are gone" test ! -e "$A_DIR" -a ! -e "$TMPDIR/port.9898"
check "the other run's server and directory are untouched" test -d "$C_DIR" -a -e "$TMPDIR/port.9899"
check "tmux was only asked about the first run's session, exactly" test "$(grep -c . "$TMPDIR/tmux.calls")" -ge 1 -a -z "$(grep -v -- "-t =$A_SESSION\$" "$TMPDIR/tmux.calls")"
"$RUN_LOCAL" --down "$C_DIR" >/dev/null 2>&1

echo "== the workdir is inside the run dir, so --down under another TMPDIR removes it"
world
CAO_PORT=9898 "$RUN_LOCAL" >"$ROOT/w.out" 2>&1
W_DIR="$(field RUN_DIR "$ROOT/w.out")"
W_WORK="$(cat "$W_DIR/workdir")"
check "the recorded workdir is a directory inside the run dir" test "$W_WORK" = "$W_DIR/work" -a -d "$W_WORK"
mkdir "$ROOT/other-tmp"
TMPDIR="$ROOT/other-tmp" "$RUN_LOCAL" --down "$W_DIR" >"$ROOT/w2.out" 2>&1; rw=$?
check "--down under a different TMPDIR succeeded" test "$rw" -eq 0
check "the run dir and the workdir are both gone" test ! -e "$W_DIR" -a ! -e "$W_WORK"

echo "== --down refuses a directory that is not a run directory"
world
mkdir "$TMPDIR/not-a-run"; echo keep >"$TMPDIR/not-a-run/file"
"$RUN_LOCAL" --down "$TMPDIR/not-a-run" >"$ROOT/e.out" 2>&1; re=$?
check "it refused" test "$re" -ne 0
check "the directory is intact" test -f "$TMPDIR/not-a-run/file"

echo "== a server that ignores the stop: --down fails and keeps its pid file"
world
CAO_PORT=9898 STUB_IGNORE_STOP=1 "$RUN_LOCAL" >"$ROOT/f.out" 2>&1; rf=$?
F_DIR="$(field RUN_DIR "$ROOT/f.out")"
check "start succeeded" test "$rf" -eq 0
CAO_STOP_TIMEOUT=2 "$RUN_LOCAL" --down "$F_DIR" >"$ROOT/f2.out" 2>&1; rf2=$?
check "--down failed" test "$rf2" -ne 0
check "--down did not claim success" test -z "$(grep 'demo torn down' "$ROOT/f2.out")"
check "server.pid and the run directory were kept" test -f "$F_DIR/server.pid"
kill -9 "$(cat "$F_DIR/server.pid")" 2>/dev/null; rm -f "$TMPDIR/port.9898"
"$RUN_LOCAL" --down "$F_DIR" >"$ROOT/f3.out" 2>&1; rf3=$?
check "--down succeeds once the server is gone" test "$rf3" -eq 0
check "the run directory is removed after the retry" test ! -e "$F_DIR"

echo "== startup rollback: install fails, server ignores the stop"
world
CAO_PORT=9898 STUB_IGNORE_STOP=1 STUB_INSTALL_STATUS=3 CAO_STOP_TIMEOUT=2 "$RUN_LOCAL" >"$ROOT/g.out" 2>&1; rg=$?
G_DIR="$(rundirs | head -n 1)"
check "the original install status is the exit status" test "$rg" -eq 3
check "the pid file was kept because the server did not exit" test -f "$G_DIR/server.pid"
check "it says how to retry" grep -q "run-local.sh --down\|--down $G_DIR" "$ROOT/g.out"
kill -9 "$(cat "$G_DIR/server.pid")" 2>/dev/null

echo "== startup rollback: install fails, server stops normally"
world
CAO_PORT=9898 STUB_INSTALL_STATUS=3 "$RUN_LOCAL" >"$ROOT/h.out" 2>&1; rh=$?
check "the original install status is the exit status" test "$rh" -eq 3
check "no run directory and no server remain" test -z "$(rundirs)" -a ! -e "$TMPDIR/port.9898"

echo "== failed launch: the exact tmux session is stopped, a similarly named one is not"
world
CAO_PORT=9898 STUB_LAUNCH_STATUS=1 "$RUN_LOCAL" >"$ROOT/i.out" 2>&1; ri=$?
check "the run failed" test "$ri" -ne 0
check "tmux kill-session used an exact =target" grep -Eq '^kill-session -t =cao-agui-demo-[A-Za-z0-9]+$' "$TMPDIR/tmux.calls"
check "the run's session was removed" test "$(grep -cv -- '-backup$' "$TMPDIR/tmux.sessions")" = 0
check "the -backup session is still there" test "$(grep -c -- '-backup$' "$TMPDIR/tmux.sessions")" = 1
check "no run directory remains" test -z "$(rundirs)"

echo "== --down when the run's session is already gone: a name-prefixed session survives"
world
CAO_PORT=9898 "$RUN_LOCAL" >"$ROOT/k.out" 2>&1
K_DIR="$(field RUN_DIR "$ROOT/k.out")"; K_SESSION="$(field SESSION "$ROOT/k.out")"
grep -Fxv -- "$K_SESSION" "$TMPDIR/tmux.sessions" >"$TMPDIR/tmux.sessions.new"; mv "$TMPDIR/tmux.sessions.new" "$TMPDIR/tmux.sessions"
"$RUN_LOCAL" --down "$K_DIR" >"$ROOT/k2.out" 2>&1; rk=$?
check "--down succeeded" test "$rk" -eq 0
check "the -backup session was not killed" grep -Fxq -- "$K_SESSION-backup" "$TMPDIR/tmux.sessions"
check "it asked tmux for the exact name" grep -Fq -- "-t =$K_SESSION" "$TMPDIR/tmux.calls"

echo "== process identity: a pid with a different start time is not ours"
world
CAO_PORT=9898 "$RUN_LOCAL" >"$ROOT/m.out" 2>&1
M_DIR="$(field RUN_DIR "$ROOT/m.out")"
M_PID="$(cat "$M_DIR/server.pid")"
check "the start time was recorded with the pid" test -s "$M_DIR/server.start"
real_start="$(cat "$M_DIR/server.start")"
echo "Mon Jan  1 00:00:00 2001" >"$M_DIR/server.start"
"$RUN_LOCAL" --down "$M_DIR" >"$ROOT/m2.out" 2>&1; rm_=$?
check "--down refused" test "$rm_" -ne 0
check "it says the pid is not the server this run started" grep -q "not the cao-server this run started" "$ROOT/m2.out"
check "the other process was not signalled" kill -0 "$M_PID"
check "the run directory was kept" test -d "$M_DIR"
echo "$real_start" >"$M_DIR/server.start"
"$RUN_LOCAL" --down "$M_DIR" >"$ROOT/m3.out" 2>&1; rm3=$?
check "with the real start time --down stops it" test "$rm3" -eq 0 -a ! -e "$M_DIR"

echo "== a cao shutdown that never returns is bounded"
world
CAO_PORT=9898 "$RUN_LOCAL" >"$ROOT/n.out" 2>&1
N_DIR="$(field RUN_DIR "$ROOT/n.out")"; N_SESSION="$(field SESSION "$ROOT/n.out")"
STUB_SHUTDOWN_HANGS=1 CAO_SHUTDOWN_TIMEOUT=2 "$RUN_LOCAL" --down "$N_DIR" >"$ROOT/n2.out" 2>&1 &
npid=$!
waited=0
while kill -0 "$npid" 2>/dev/null && [ "$waited" -lt 30 ]; do waited=$((waited + 1)); sleep 1; done
if kill -0 "$npid" 2>/dev/null; then kill -9 "$npid" 2>/dev/null; hung=1; else hung=0; fi
wait "$npid" 2>/dev/null; rn=$?
check "--down returned instead of hanging" test "$hung" -eq 0
check "--down still succeeded" test "$rn" -eq 0
check "the exact tmux session fallback still ran" grep -Fq -- "kill-session -t =$N_SESSION" "$TMPDIR/tmux.calls"
check "the server was stopped and the run removed" test ! -e "$N_DIR" -a ! -e "$TMPDIR/port.9898"

echo "== teardown ignores an inherited CAO_API_HOST"
world
CAO_PORT=9898 "$RUN_LOCAL" >"$ROOT/h.out" 2>&1
H_DIR="$(field RUN_DIR "$ROOT/h.out")"
: >"$TMPDIR/cao.calls"
CAO_API_HOST=other-host.invalid "$RUN_LOCAL" --down "$H_DIR" >"$ROOT/h2.out" 2>&1; rh=$?
check "--down succeeded" test "$rh" -eq 0
check "cao shutdown ran" grep -q "^shutdown " "$TMPDIR/cao.calls"
check "cao shutdown was pointed at 127.0.0.1, not the inherited host" grep -q "^shutdown .* host=127.0.0.1 " "$TMPDIR/cao.calls"
check "the inherited host never reached any cao call" test -z "$(grep 'other-host' "$TMPDIR/cao.calls")"

echo "== server fails to start: its log is printed and kept"
world
CAO_PORT=9898 STUB_SERVER_FAILS=1 CAO_START_TIMEOUT=3 "$RUN_LOCAL" >"$ROOT/j.out" 2>&1; rj=$?
check "the run failed" test "$rj" -ne 0
check "the log tail is printed" grep -q "boom: cannot bind" "$ROOT/j.out"
kept="$(sed -n 's/^run-local: full server log kept at //p' "$ROOT/j.out")"
check "the message names a retained log" test -n "$kept"
check "the retained log has the error" grep -q "boom: cannot bind" "$kept"
check "its name is random, not derived from the session" test -n "$(printf '%s' "$kept" | grep -E 'cao-agui-server-log\.[A-Za-z0-9]{6}$')"
check "it is private to the user" test "$(file_mode "$kept")" = 600
check "the run directory was removed" test -z "$(rundirs)"

echo "== file_mode works with BSD stat and with a GNU-like stat"
modefile="$ROOT/mode-probe"; : >"$modefile"; chmod 640 "$modefile"
check "BSD stat (the real one here, if this is macOS)" test "$(file_mode "$modefile")" = 640
# A GNU-like stat: -f is filesystem status (it treats a '%Lp' operand as a file
# name that does not exist and prints filesystem info for the real file), and
# -c FORMAT prints the mode.
mkdir "$ROOT/gnu"
cat >"$ROOT/gnu/stat" <<'GNU'
#!/bin/sh
if [ "$1" = "-f" ]; then
  shift
  for f in "$@"; do
    if [ -e "$f" ]; then echo "  File: \"$f\""; echo "    ID: 0 Namelen: 255 Type: ext2/ext3"
    else echo "stat: cannot read file system information for '$f': No such file or directory" >&2; rc=1; fi
  done
  exit "${rc:-0}"
fi
if [ "$1" = "-c" ]; then
  case "$2" in %a)
    mode="$(/usr/bin/stat -c %a "$3" 2>/dev/null)" || mode="$(/usr/bin/stat -f %Lp "$3")" || exit $?
    printf '%s\n' "$mode"; exit 0;;
  esac
fi
echo "stat: invalid option" >&2; exit 1
GNU
chmod +x "$ROOT/gnu/stat"
check "GNU-like stat gives just the mode" test "$(PATH="$ROOT/gnu:$PATH" file_mode "$modefile")" = 640
# What made `stat -f %Lp F || stat -c %a F` wrong on GNU: its `-f` call does not
# fail cleanly, it prints filesystem info for F (and errors on the %Lp operand).
check "on GNU, stat -f prints filesystem info, not a mode" test -n "$(PATH="$ROOT/gnu:$PATH" stat -f %Lp "$modefile" 2>/dev/null | grep 'Namelen')"

echo "== a stub server that ignores its stop is still reaped after a failed teardown and a reset"
world
CAO_PORT=9898 STUB_IGNORE_STOP=1 "$RUN_LOCAL" >"$ROOT/r.out" 2>&1
R_DIR="$(field RUN_DIR "$ROOT/r.out")"
R_PID="$(tail -n 1 "$STUB_PIDS" | cut -d ' ' -f 1)"
CAO_STOP_TIMEOUT=1 "$RUN_LOCAL" --down "$R_DIR" >"$ROOT/r2.out" 2>&1; rr=$?
check "the teardown failed" test "$rr" -ne 0
check "the stub server is still running" kill -0 "$R_PID"
world
check "the reset reaped it although its run directory is gone" test ! -e "$R_DIR"
check "no stub server is left after the reset" pid_gone "$R_PID"
CAO_PORT=9898 STUB_IGNORE_STOP=1 "$RUN_LOCAL" >"$ROOT/r3.out" 2>&1
R2_PID="$(tail -n 1 "$STUB_PIDS" | cut -d ' ' -f 1)"
rm -rf "${TMPDIR:?}"/*
reap_stubs
check "the EXIT-path reaper stops it after its run directory was deleted" pid_gone "$R2_PID"

echo "== the reaper signals a pid only when its start time matches the recorded one"
world
sleep 300 &
U_PID=$!
printf '%s %s\n' "$U_PID" "Thu Jan  1 00:00:00 1970" >"$STUB_PIDS"
reap_stubs 2>"$ROOT/u.err"
check "an unrelated live process with a wrong recorded start time is left alone" kill -0 "$U_PID"
check "the reaper said it was not ours" grep -q "not ours" "$ROOT/u.err"
printf '%s %s\n' "$U_PID" "$(proc_start "$U_PID")" >"$STUB_PIDS"
reap_stubs
check "the same pid with its true start time is stopped" pid_gone "$U_PID"
wait "$U_PID" 2>/dev/null

if [ "$FAILS" -eq 0 ]; then echo "RESULT: PASS all"; else echo "RESULT: FAIL $FAILS"; fi
[ "$FAILS" -eq 0 ]
