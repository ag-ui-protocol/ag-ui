#!/usr/bin/env bash
set -euo pipefail

# Links the dojo against locally-built CopilotKit packages (TypeScript + Python).
# Expects the CopilotKit repo to be cloned alongside ag-ui:
#   /some/path/ag-ui/
#   /some/path/CopilotKit/

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOJO_DIR="$(dirname "$SCRIPT_DIR")"
AGUI_ROOT="$(cd "$DOJO_DIR/../.." && pwd)"
COPILOTKIT_ROOT="$(cd "$AGUI_ROOT/../CopilotKit" && pwd 2>/dev/null)" || {
  echo "ERROR: CopilotKit repo not found at $AGUI_ROOT/../CopilotKit"
  echo "Clone it alongside ag-ui: git clone <copilotkit-repo> $(dirname "$AGUI_ROOT")/CopilotKit"
  exit 1
}

echo "ag-ui root:       $AGUI_ROOT"
echo "CopilotKit root:  $COPILOTKIT_ROOT"
echo ""

# 1. Build CopilotKit TypeScript packages
echo "=== Building CopilotKit TypeScript packages ==="
cd "$COPILOTKIT_ROOT"
./node_modules/.bin/nx run-many -t build -p \
  @copilotkit/react-core \
  @copilotkit/react-ui \
  @copilotkit/runtime \
  @copilotkit/runtime-client-gql \
  @copilotkit/shared \
  @copilotkit/a2ui-renderer

# 2. Link CopilotKit into ag-ui workspace via .pnpmfile.cjs
echo ""
echo "=== Linking CopilotKit packages into ag-ui workspace ==="
cd "$AGUI_ROOT"
COPILOTKIT_LOCAL=1 pnpm install

# 3. Install local CopilotKit Python SDK for langgraph agent
LANGGRAPH_EXAMPLES="$AGUI_ROOT/integrations/langgraph/python/examples"
if [ -d "$LANGGRAPH_EXAMPLES" ] && [ -d "$COPILOTKIT_ROOT/sdk-python" ]; then
  echo ""
  echo "=== Installing local CopilotKit Python SDK for langgraph agent ==="
  cd "$LANGGRAPH_EXAMPLES"
  uv pip install -e "$COPILOTKIT_ROOT/sdk-python"
fi

echo ""
echo "=== Done! CopilotKit packages linked locally ==="
echo "Run 'pnpm install' (without COPILOTKIT_LOCAL) to revert to npm versions."
echo ""
echo "NOTE: 'uv run dev' re-syncs and reverts the Python SDK to PyPI."
echo "Start the langgraph agent with uvicorn directly instead:"
echo "  cd integrations/langgraph/python/examples"
echo "  .venv/bin/uvicorn agents.dojo:app --host 0.0.0.0 --port 8004 --reload"
