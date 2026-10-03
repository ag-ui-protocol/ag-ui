#!/usr/bin/env bash
# Runs the LiteLLM streamed-function-call-args test (no API key, no network):
# real ADK Runner in SSE mode + real ADKAgent, with only LiteLLM's HTTP call faked.
#
#   ./run_test.sh                 run both focused streaming test files
#   ./run_test.sh -k flag_off     extra args are passed straight to pytest
#   ADK_VERSION=1.35.0 ./run_test.sh   compare against another ADK release
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"                # integrations/adk-middleware/python
VENV="$HERE/.venv-e2e"
ADK_VERSION="${ADK_VERSION:-2.10.0}"
command -v uv >/dev/null || { echo "uv is required (https://docs.astral.sh/uv/)"; exit 2; }

STAMP="$VENV/.adk-version"
if [[ ! -x "$VENV/bin/python" || "$(cat "$STAMP" 2>/dev/null)" != "$ADK_VERSION" ]]; then
  echo ">> creating $VENV with google-adk==$ADK_VERSION"
  uv venv "$VENV" --python 3.12 -q --clear
  uv pip install -q --python "$VENV/bin/python" -e "$PKG" "google-adk==$ADK_VERSION" \
    litellm uvicorn fastapi python-dotenv
  echo "$ADK_VERSION" > "$STAMP"
fi
"$VENV/bin/python" -c "import pytest, pytest_asyncio" 2>/dev/null \
  || uv pip install -q --python "$VENV/bin/python" pytest pytest-asyncio
"$VENV/bin/python" -c "import google.adk as a, google.genai as g; print('>> google-adk', a.__version__, '| google-genai', g.__version__)"

cd "$PKG"
exec "$VENV/bin/python" -m pytest tests/test_litellm_streaming_fc_args.py -p no:cacheprovider \
  tests/test_streamed_tool_args.py -o addopts="--tb=short -v" -W ignore "$@"
