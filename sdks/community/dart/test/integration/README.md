# Dart SDK Integration Tests

This directory contains integration tests for the Dart SDK that validate functionality against AG-UI protocol servers.

## Prerequisites

- Dart SDK >= 3.3.0
- Docker (recommended) OR Python 3.11+

## Testing Options

### Option 1: Docker-based Testing (Recommended)

Uses the official `ag-ui-protocol/ag-ui-server` Docker image for consistent, isolated testing.

```bash
# Ensure Docker image is available
docker pull ag-ui-protocol/ag-ui-server:latest

# Run Docker-based integration tests
dart test test/integration/simple_qa_docker_test.dart
dart test test/integration/tool_generative_ui_docker_test.dart

# Or run all Docker tests
dart test test/integration/*docker*.dart
```

### Option 2: Python Server Testing

Uses the Python example server from the TypeScript SDK.

## Running Integration Tests

### Automated (Recommended)

The integration tests automatically manage the server lifecycle:

```bash
# From the Dart SDK directory
cd sdks/community/dart

# Run all integration tests (starts server automatically)
dart test test/integration/

# Run specific test file
dart test test/integration/simple_qa_test.dart
dart test test/integration/tool_generative_ui_test.dart
```

### Manual Server Start

If you prefer to run the server manually or debug server issues:

```bash
# Start the server using the helper script
./scripts/start_test_server.sh

# In another terminal, run tests with custom URL
export AGUI_BASE_URL=http://127.0.0.1:20203
dart test test/integration/
```

### Using Different Server

To test against a different server instance:

```bash
# Set custom server URL
export AGUI_BASE_URL=http://localhost:8080

# Run tests
dart test test/integration/
```

## Environment Variables

- `AGUI_BASE_URL`: Override the default server URL (default: `http://127.0.0.1:20203`)
- `AGUI_SKIP_INTEGRATION`: Set to `1` to skip integration tests (useful in CI without server)
- `AGUI_PORT`: Override the default port when using the start script (default: `20203`)

## Test Structure

```
test/integration/
├── helpers/
│   ├── server_lifecycle.dart    # Server management utilities
│   └── test_helpers.dart        # Shared test utilities
├── artifacts/                    # Test output and transcripts
├── simple_qa_test.dart          # Simple Q&A scenario tests
└── tool_generative_ui_test.dart # Tool-based UI tests
```

## Artifacts

Test runs generate artifacts in `test/integration/artifacts/`:
- JSONL transcripts of all events
- Server logs for debugging
- Structured test output

## Troubleshooting

### Server Won't Start

1. Check Python version: `python3 --version` (should be 3.11+)
2. Verify server directory exists
3. Check port availability: `lsof -i :20203`
4. Review server logs in artifacts directory

### Tests Timeout

1. Increase timeout in test helpers if needed
2. Check server is responding: `curl http://127.0.0.1:20203/health`
3. Review server logs for errors

### Skipping Integration Tests

For environments where the server cannot run:

```bash
export AGUI_SKIP_INTEGRATION=1
dart test test/
```

## Python Server Setup

The integration tests use the example server from:
```
typescript-sdk/integrations/server-starter-all-features/server/python/
```

First-time setup:
```bash
cd typescript-sdk/integrations/server-starter-all-features/server/python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## CI/CD Integration

For CI pipelines, consider:

1. Using `AGUI_SKIP_INTEGRATION=1` if server setup is complex
2. Running server in Docker container for isolation
3. Using health checks with retries for reliability
4. Storing artifacts for debugging failed runs