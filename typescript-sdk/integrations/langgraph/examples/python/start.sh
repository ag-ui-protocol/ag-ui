#!/bin/bash

# Start the application
exec pnpx @langchain/langgraph-cli@latest dev --no-browser --host 0.0.0.0 --port ${PORT:-8000}
