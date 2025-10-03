# AG-UI Dart Example: Tool Based Generative UI

A CLI application demonstrating the Tool Based Generative UI flow using the AG-UI Dart SDK. This example shows how to connect to an AG-UI server, send messages, stream events, and handle tool calls in an interactive session.

## Overview

This example demonstrates:
- Connecting to an AG-UI server endpoint using SSE (Server-Sent Events)
- Sending user messages and receiving assistant responses
- Handling tool calls with interactive or automatic responses
- Processing multi-turn conversations with tool interactions
- Streaming and decoding AG-UI protocol events

The flow creates a haiku generation assistant that uses tool calls to present structured poetry in both Japanese and English.

## Prerequisites

- **Dart SDK**: Version 3.3.0 or higher
  ```bash
  # Check your Dart version
  dart --version
  ```
  
- **Python**: Version 3.10 or higher (for running the example server)
  ```bash
  # Check your Python version
  python --version
  ```

- **Poetry or uv**: Python package manager for server dependencies
  ```bash
  # Install poetry (if not installed)
  curl -sSL https://install.python-poetry.org | python3 -
  
  # OR install uv (faster alternative)
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```

## Setup

### 1. Clone the Repository

```bash
# Clone the AG-UI repository
git clone https://github.com/ag-ui-protocol/ag-ui.git
cd ag-ui
```

### 2. Install Dart Dependencies

```bash
# Navigate to the Dart example directory
cd sdks/community/dart/example

# Install dependencies
dart pub get
```

### 3. Setup Python Server

In a separate terminal window:

```bash
# Navigate to the Python server directory
cd typescript-sdk/integrations/server-starter-all-features/server/python

# Install dependencies with poetry
poetry install

# OR with uv (faster)
uv pip install -e .
```

## Running the Example

### Step 1: Start the Python Server

In your server terminal:

```bash
# From: typescript-sdk/integrations/server-starter-all-features/server/python

# Using poetry
poetry run dev

# OR using uv
uv run dev

# OR directly with Python
python -m example_server
```

The server will start on `http://127.0.0.1:8000` by default. You should see:
```
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
INFO:     Started reloader process [...]
```

### Step 2: Run the Dart Example

In your Dart terminal:

```bash
# From: sdks/community/dart/example

# Interactive mode (prompts for input)
dart run

# Send a specific message
dart run -- -m "Create a haiku about AI"

# Auto-respond to tool calls (non-interactive)
dart run -- -a -m "Generate a haiku"

# JSON output for debugging
dart run -- -j -m "Test message"

# Use custom server URL
dart run -- -u http://localhost:8000 -m "Hello"

# With environment variable
export AG_UI_BASE_URL=http://localhost:8000
dart run -- -m "Create poetry"
```

### Command-Line Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--url` | `-u` | Base URL of the AG-UI server | `http://127.0.0.1:8000` or `$AG_UI_BASE_URL` |
| `--api-key` | `-k` | API key for authentication | `$AG_UI_API_KEY` |
| `--message` | `-m` | Message to send (if not provided, reads from stdin) | Interactive prompt |
| `--json` | `-j` | Output structured JSON logs | `false` |
| `--dry-run` | `-d` | Print planned requests without executing | `false` |
| `--auto-tool` | `-a` | Automatically provide tool results | `false` |
| `--help` | `-h` | Show help message | - |

## Expected Output and Behavior

### Normal Flow

When you run the example with a message like "Create a haiku":

1. **Initial Request**: The client sends your message to the server
   ```
   📍 Starting Tool Based Generative UI flow
   📍 Starting run with thread_id: thread_xxx, run_id: run_xxx
   📍 User message: Create a haiku
   ```

2. **Event Stream**: The server responds with SSE events
   ```
   📨 RUN_STARTED
   📨 MESSAGES_SNAPSHOT
   📍 Tool call detected: generate_haiku (will process after run completes)
   📨 RUN_FINISHED
   ```

3. **Tool Call Processing**: The example detects a tool call for `generate_haiku`
   - In interactive mode: Prompts you to enter a tool result
   - In auto mode (`-a`): Automatically provides "thanks" as the result
   ```
   📍 Processing tool call: generate_haiku
   
   Tool "generate_haiku" was called with:
   {"japanese": ["エーアイの", "橋つなぐ道", "コパキット"], ...}
   Enter tool result (or press Enter for default):
   ```

4. **Tool Response**: After providing the tool result, a new run starts
   ```
   📍 Sending tool response(s) to server with new run...
   📨 RUN_STARTED
   📨 MESSAGES_SNAPSHOT
   🤖 Haiku created
   📨 RUN_FINISHED
   ```

### Event Types

The example handles these AG-UI protocol events:

- **RUN_STARTED**: Indicates a new agent run has begun
- **MESSAGES_SNAPSHOT**: Contains the current message history including assistant responses and tool calls
- **RUN_FINISHED**: Marks the completion of an agent run

### Tool Call Structure

Tool calls in the example follow this format:
```json
{
  "id": "tool_call_xxx",
  "type": "function",
  "function": {
    "name": "generate_haiku",
    "arguments": "{\"japanese\": [...], \"english\": [...]}"
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AG_UI_BASE_URL` | Base URL of the AG-UI server | `http://127.0.0.1:8000` |
| `AG_UI_API_KEY` | API key for authentication | None |
| `DEBUG` | Enable debug logging when set to `true` | `false` |

Example usage:
```bash
export AG_UI_BASE_URL=http://localhost:8000
export DEBUG=true
dart run -- -m "Hello"
```

### Interactive Mode Example

```
$ dart run -- -m "Create a haiku"
Enter your message (press Enter when done):
Create a haiku
📍 Starting Tool Based Generative UI flow
📍 Starting run with thread_id: thread_1734567890123, run_id: run_1734567890456
📍 User message: Create a haiku
📨 RUN_STARTED
📍 Run started: run_1734567890456
📨 MESSAGES_SNAPSHOT
📍 Tool call detected: generate_haiku (will process after run completes)
📨 RUN_FINISHED
📍 Run finished: run_1734567890456
📍 Processing 1 pending tool calls
📍 Processing tool call: generate_haiku

Tool "generate_haiku" was called with:
{"japanese":["エーアイの","橋つなぐ道","コパキット"],"english":["From AI's realm","A bridge-road linking us—","CopilotKit."]}
Enter tool result (or press Enter for default):
thanks
📍 Sending tool response(s) to server with new run...
📍 Starting run with thread_id: thread_1734567890123, run_id: run_1734567890789
📨 RUN_STARTED
📍 Run started: run_1734567890789
📨 MESSAGES_SNAPSHOT
🤖 Haiku created
📨 RUN_FINISHED
📍 Run finished: run_1734567890789
📍 All tool calls already processed, run complete
```

### Auto Mode Example

```
$ dart run -- -a -m "Generate a haiku"
📍 Starting Tool Based Generative UI flow
📍 Starting run with thread_id: thread_1734567890123, run_id: run_1734567890456
📍 User message: Generate a haiku
📨 RUN_STARTED
📍 Run started: run_1734567890456
📨 MESSAGES_SNAPSHOT
📍 Tool call detected: generate_haiku (will process after run completes)
📨 RUN_FINISHED
📍 Run finished: run_1734567890456
📍 Processing 1 pending tool calls
📍 Processing tool call: generate_haiku
📍 Auto-generated tool result: thanks
📍 Sending tool response(s) to server with new run...
📍 Starting run with thread_id: thread_1734567890123, run_id: run_1734567890789
📨 RUN_STARTED
📍 Run started: run_1734567890789
📨 MESSAGES_SNAPSHOT
🤖 Haiku created
📨 RUN_FINISHED
📍 Run finished: run_1734567890789
📍 All tool calls already processed, run complete
```

## Troubleshooting

### 1. Connection Refused Error

**Problem**: `Connection refused` or `Failed to connect to server`

**Solutions**:
- Verify the Python server is running: `curl http://127.0.0.1:8000/health`
- Check the server URL matches: Default is port 8000, not 20203
- Ensure no firewall is blocking local connections
- Try using `localhost` instead of `127.0.0.1`
- Check server logs for startup errors

### 2. Timeout or No Response

**Problem**: Request times out or no events received

**Solutions**:
- Verify the endpoint path: `/tool_based_generative_ui` (note underscores)
- Check server logs for incoming requests
- Ensure the server has all dependencies: `poetry install` or `uv pip install -e .`
- Try the dry-run mode to see the request: `dart run -- -d -m "Test"`
- Increase logging with `DEBUG=true` environment variable

### 3. Event Decoding Errors

**Problem**: `Failed to decode event` messages

**Solutions**:
- Ensure you're using compatible SDK versions
- Check that the Python server is from the same AG-UI repository
- Verify SSE format with: `curl -N -H "Accept: text/event-stream" http://127.0.0.1:8000/tool_based_generative_ui -d '{"messages":[]}' -H "Content-Type: application/json"`
- Look for malformed JSON in debug output
- Update both Dart and Python dependencies

### 4. Tool Call Not Processing

**Problem**: Tool calls detected but not executed

**Solutions**:
- In interactive mode, ensure you're providing input when prompted
- Use `-a` flag for automatic tool responses
- Check that tool call IDs match between detection and processing
- Verify the server is sending proper tool call format
- Look for "Processing tool call" messages in output

### 5. Python Server Won't Start

**Problem**: Server fails to start or import errors

**Solutions**:
- Ensure Python version is 3.10+: `python --version`
- Install poetry correctly: `curl -sSL https://install.python-poetry.org | python3 -`
- Clear poetry cache: `poetry cache clear pypi --all`
- Try uv instead: `uv pip install -e .` then `uv run dev`
- Check for port conflicts: `lsof -i :8000` (macOS/Linux)
- Install in a clean virtual environment

### 6. Dart Dependencies Issues

**Problem**: `pub get` fails or import errors

**Solutions**:
- Ensure Dart SDK version >= 3.3.0: `dart --version`
- Clear pub cache: `dart pub cache clean`
- Update dependencies: `dart pub upgrade`
- Check path to parent package: Verify `path: ../` in pubspec.yaml
- Run from correct directory: `cd sdks/community/dart/example`

### 7. Authentication Errors

**Problem**: 401 Unauthorized or 403 Forbidden

**Solutions**:
- The example server doesn't require authentication by default
- If using a custom server, set: `export AG_UI_API_KEY=your-key`
- Or pass directly: `dart run -- -k "your-api-key" -m "Test"`
- Check server configuration for auth requirements
- Verify API key format and headers in dry-run mode

## Project Structure

```
sdks/community/dart/
├── lib/                  # AG-UI Dart SDK implementation
│   └── ag_ui.dart       # Main SDK exports
├── example/             # This example application
│   ├── lib/
│   │   └── main.dart   # CLI implementation
│   ├── pubspec.yaml    # Example dependencies
│   └── README.md       # This file
└── README.md           # Main SDK documentation
```

## References

- [AG-UI Documentation](https://docs.ag-ui.com)
- [AG-UI Specification](https://github.com/ag-ui-protocol/specification)
- [Main Dart SDK README](../README.md)
- [Python Server Source](../../../../typescript-sdk/integrations/server-starter-all-features/server/python/)
- [AG-UI Dojo Examples](../../../../typescript-sdk/apps/dojo)
- [TypeScript SDK](../../../../typescript-sdk/)

## Related Examples

For more AG-UI protocol examples and patterns, see:
- TypeScript integrations in `typescript-sdk/integrations/`
- Python SDK examples in `python-sdk/examples/`
- AG-UI Dojo for interactive demonstrations

## Contributing

This example is part of the AG-UI community SDKs. For issues or contributions:
1. Open an issue in the [AG-UI repository](https://github.com/ag-ui-protocol/ag-ui/issues)
2. Tag it with `dart-sdk` and `example`
3. Include full error output and environment details

## License

This example is provided under the same license as the AG-UI project. See the repository root for license details.