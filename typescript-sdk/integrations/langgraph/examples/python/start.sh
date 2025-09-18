#!/bin/bash

# Handle virtual environment path mismatch by unsetting VIRTUAL_ENV
# This prevents the warning about path mismatch
unset VIRTUAL_ENV

# Start the application
exec pnpx @langchain/langgraph-cli@latest dev --no-browser --host 0.0.0.0 --port ${PORT:-8000}
