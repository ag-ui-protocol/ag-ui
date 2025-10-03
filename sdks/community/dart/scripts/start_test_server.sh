#!/bin/bash

# Script to start the Python example server for integration tests
# Usage: ./scripts/start_test_server.sh

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/../../../.." && pwd )"
SERVER_DIR="$PROJECT_ROOT/typescript-sdk/integrations/server-starter-all-features/server/python"
PORT="${AGUI_PORT:-20203}"

echo "Starting AG-UI Python example server..."
echo "Server directory: $SERVER_DIR"
echo "Port: $PORT"

# Check if server directory exists
if [ ! -d "$SERVER_DIR" ]; then
    echo "Error: Server directory not found at $SERVER_DIR"
    exit 1
fi

cd "$SERVER_DIR"

# Check if virtual environment exists
if [ ! -d ".venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv .venv
fi

# Activate virtual environment
source .venv/bin/activate

# Install dependencies if needed
if ! python -c "import fastapi" 2>/dev/null; then
    echo "Installing Python dependencies..."
    pip install -r requirements.txt
fi

# Add health endpoint to the server if not already present
HEALTH_CHECK_FILE="$SERVER_DIR/example_server/health.py"
if [ ! -f "$HEALTH_CHECK_FILE" ]; then
    cat > "$HEALTH_CHECK_FILE" << 'EOF'
"""Health check endpoint for testing."""
from fastapi import APIRouter

router = APIRouter()

@router.get("/health")
async def health_check():
    """Simple health check endpoint."""
    return {"status": "healthy", "service": "ag-ui-example-server"}
EOF

    # Add health router to __init__.py if needed
    if ! grep -q "health" "$SERVER_DIR/example_server/__init__.py"; then
        cat >> "$SERVER_DIR/example_server/__init__.py" << 'EOF'

# Health check endpoint
from .health import router as health_router
app.include_router(health_router)
EOF
    fi
fi

# Start the server
echo "Starting server on port $PORT..."
export PYTHONUNBUFFERED=1
python -m uvicorn example_server:app --host 0.0.0.0 --port "$PORT" --reload