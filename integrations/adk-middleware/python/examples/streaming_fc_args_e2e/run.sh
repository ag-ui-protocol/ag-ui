#!/usr/bin/env bash
# One-shot E2E runner: webapp -> AG-UI endpoint (ag_ui_adk) -> ADK agent -> LLM.
#
#   ./run.sh                 start server + open webapp   (http://127.0.0.1:${PORT:-8010})
#   ./run.sh replay          same, with the keyless replay model (streams real-looking arg
#                            fragments through ADK's LiteLLM adapter) -> the webapp should PASS
#   ./run.sh probe [args]    headless probe (run_e2e.py), same venv
#   ./run.sh reset           delete the .venv-e2e virtualenv
#
# Config (examples/streaming_fc_args_e2e/.env, see .env.example):
#   GOOGLE_API_KEY, GOOGLE_GENAI_USE_VERTEXAI=FALSE, E2E_MODEL, STREAM_FC_ARGS, ...
# Overrides: ADK_VERSION=2.10.0 (default), PORT=8010, NO_OPEN=1
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"                # integrations/adk-middleware/python
VENV="$HERE/.venv-e2e"
ADK_VERSION="${ADK_VERSION:-2.10.0}"
PORT="${PORT:-8010}"

[[ "$PORT" =~ ^[0-9]+$ ]] && (( 10#$PORT >= 1 && 10#$PORT <= 65535 )) || {
  echo "Invalid PORT: $PORT" >&2; exit 2;
}

if [[ "${1:-}" == "reset" ]]; then rm -rf "$VENV"; echo "removed $VENV"; exit 0; fi
command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/)"; exit 2; }

# Python loads an optional .env with python-dotenv; exported overrides take
# precedence. Replay needs neither a .env file nor provider credentials.
if [[ "${1:-}" == "replay" ]]; then export E2E_MODEL=replay; shift; fi
case "${1:-}" in
  ""|probe) ;;
  *) echo "Usage: ./run.sh [replay|probe [options]|reset]" >&2; exit 2 ;;
esac

# (Re)build the venv when missing or when the requested ADK version changed.
STAMP="$VENV/.adk-version"
if [[ ! -x "$VENV/bin/python" || "$(cat "$STAMP" 2>/dev/null)" != "$ADK_VERSION" ]]; then
  echo ">> creating $VENV with google-adk==$ADK_VERSION"
  uv venv "$VENV" --python 3.12 -q --clear
  uv pip install -q --python "$VENV/bin/python" -e "$PKG" "google-adk==$ADK_VERSION" \
    litellm uvicorn fastapi python-dotenv
  echo "$ADK_VERSION" > "$STAMP"
fi
"$VENV/bin/python" -c "import google.adk as a, google.genai as g; print('>> google-adk', a.__version__, '| google-genai', g.__version__)"

if [[ "${1:-}" == "probe" ]]; then shift; exec "$VENV/bin/python" "$HERE/run_e2e.py" "$@"; fi

URL="http://127.0.0.1:$PORT"
echo ">> starting example at $URL (default model: replay; see /config for active configuration)"
if [[ -z "${NO_OPEN:-}" ]]; then
  ( for _ in $(seq 1 40); do curl -sf "$URL/config" >/dev/null 2>&1 && { open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || true; break; }; sleep 0.5; done ) &
fi
PORT="$PORT" exec "$VENV/bin/python" "$HERE/server.py"
