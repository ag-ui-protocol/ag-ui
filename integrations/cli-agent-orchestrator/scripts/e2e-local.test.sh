#!/usr/bin/env bash
# Test for e2e-local.sh's Dojo startup wait, against stub node/pnpm/curl/tmux.
# No network, no browser, no CAO. Run it directly:
#
#   integrations/cli-agent-orchestrator/scripts/e2e-local.test.sh
#
# The stub `pnpm` exits at once, as a Dojo that cannot start would. The script
# must stop on that, print the Dojo log, and say the Dojo exited, rather than
# poll a closed port for the whole timeout.
#
# Written for bash 3.2, which is what macOS ships.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/e2e-local-test.XXXXXX")" || { echo "cannot create a fixture directory" >&2; exit 1; }
[ -n "$ROOT" ] && [ -d "$ROOT" ] || { echo "no fixture directory" >&2; exit 1; }
trap 'rm -rf "$ROOT"' EXIT
STUBS="$ROOT/bin"
mkdir -p "$STUBS" "$ROOT/tmp" || exit 1

# node: the Playwright presence checks pass.
printf '#!/bin/sh\nexit 0\n' >"$STUBS/node"
printf '#!/bin/sh\nexit 0\n' >"$STUBS/tmux"
# curl: by default nothing is listening, so no port answers. With STUB_CURL_MODE=404 the status poll
# (the call that asks for -w) answers 404 and writes response headers to the -D file.
cat >"$STUBS/curl" <<'STUB'
#!/bin/sh
hdr=""; wflag=0
while [ $# -gt 0 ]; do
  case "$1" in -D) hdr="$2"; shift ;; -w) wflag=1 ;; esac
  shift
done
if [ "${STUB_CURL_MODE:-down}" = 404 ] && [ "$wflag" = 1 ]; then
  [ -n "$hdr" ] && printf 'HTTP/1.1 404 Not Found\r\nx-stub-header: yes\r\nContent-Type: text/html\r\n\r\n' >"$hdr"
  printf 404
  exit 0
fi
echo 000
exit 7
STUB
# pnpm: the Dojo dies at once and says why.
printf '#!/bin/sh\necho "dojo-stub: cannot start" >&2\nexit 1\n' >"$STUBS/pnpm"
chmod +x "$STUBS"/*

FAILS=0
check() {
  if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; FAILS=$((FAILS + 1)); fi
}

out="$(PATH="$STUBS:$PATH" TMPDIR="$ROOT/tmp" DOJO_PORT=39999 bash "$SCRIPT_DIR/e2e-local.sh" 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then check "a Dojo that exits at startup fails the script" ok; else check "a Dojo that exits at startup fails the script" no; fi
case "$out" in *"the Dojo exited during startup"*) check "the message says the Dojo exited" ok ;; *) check "the message says the Dojo exited" no ;; esac
case "$out" in *"dojo-stub: cannot start"*) check "the Dojo log tail is printed" ok ;; *) check "the Dojo log tail is printed" no ;; esac
case "$out" in *"did not serve the Tool Approval page"*) check "it did not fall through to the timeout message" no ;; *) check "it did not fall through to the timeout message" ok ;; esac

# A Dojo that stays up but keeps answering 404: the script must give up at the deadline and say what it saw.
printf '#!/bin/sh\necho "dojo-stub: up but serving nothing" >&2\nexec sleep 60\n' >"$STUBS/pnpm"
chmod +x "$STUBS/pnpm"
out2="$(PATH="$STUBS:$PATH" TMPDIR="$ROOT/tmp" DOJO_PORT=39998 STUB_CURL_MODE=404 E2E_DOJO_WAIT=2 bash "$SCRIPT_DIR/e2e-local.sh" 2>&1)"
status2=$?
if [ "$status2" -ne 0 ]; then check "a Dojo that keeps answering 404 fails the script" ok; else check "a Dojo that keeps answering 404 fails the script" no; fi
case "$out2" in *"did not serve the Tool Approval page within 2s"*) check "the deadline message is printed" ok ;; *) check "the deadline message is printed" no ;; esac
case "$out2" in *"last status from"*": 404"*) check "the last status is printed" ok ;; *) check "the last status is printed" no ;; esac
case "$out2" in *"x-stub-header: yes"*) check "the response headers are printed" ok ;; *) check "the response headers are printed" no ;; esac
case "$out2" in *"dojo-stub: up but serving nothing"*) check "the Dojo log tail is printed on a 404 timeout" ok ;; *) check "the Dojo log tail is printed on a 404 timeout" no ;; esac
case "$out2" in *"a 404 here means"*) check "the 404 hint is printed" ok ;; *) check "the 404 hint is printed" no ;; esac

if [ "$FAILS" -eq 0 ]; then echo "RESULT: PASS all"; else echo "RESULT: $FAILS failed"; echo "$out" | tail -15; echo "$out2" | tail -15; exit 1; fi
