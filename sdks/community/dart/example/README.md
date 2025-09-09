# AG-UI Dart SDK Example: Tool Based Generative UI

A command-line interface (CLI) example demonstrating the Tool Based Generative UI flow using the AG-UI Dart SDK.

## Features

- Connect to an AG-UI server endpoint
- Send user messages
- Stream and process SSE events
- Handle tool calls interactively or automatically
- Support for JSON output and dry-run modes
- Configurable timeouts and error handling

## Prerequisites

1. **Dart SDK**: Version 3.3.0 or higher
2. **Python Environment**: To run the example server
3. **AG-UI Server**: The Python example server must be running

## Setup

### 1. Install Dependencies

From the example directory:

```bash
cd sdks/community/dart/example
dart pub get
```

### 2. Start the Python Example Server

In a separate terminal, start the Tool Based Generative UI server:

```bash
# Navigate to the Python server directory
cd typescript-sdk/integrations/server-starter-all-features/server/python

# Install Python dependencies (if not already done)
pip install -r requirements.txt

# Start the server
python -m example_server.server
```

The server will start on `http://127.0.0.1:20203` by default.

## Usage

### Basic Usage

```bash
# Interactive mode - prompts for message input
dart run ag_ui_example

# Send a specific message
dart run ag_ui_example -m "Create a haiku about AI"

# Auto-respond to tool calls (non-interactive)
dart run ag_ui_example -a -m "Create a haiku"
```

### Configuration Options

```bash
# Use a different server URL
dart run ag_ui_example -u http://localhost:8080 -m "Hello"

# Set via environment variable
export AG_UI_BASE_URL=http://localhost:8080
dart run ag_ui_example -m "Hello"

# Use API key authentication
dart run ag_ui_example -k "your-api-key" -m "Hello"

# Or via environment variable
export AG_UI_API_KEY="your-api-key"
dart run ag_ui_example -m "Hello"
```

### Debug and Testing Options

```bash
# Dry run - shows what would be sent without executing
dart run ag_ui_example -d -m "Test message"

# JSON output for debugging
dart run ag_ui_example -j -m "Test message"

# Enable debug logging
DEBUG=true dart run ag_ui_example -m "Test"

# Show help
dart run ag_ui_example -h
```

## Example Flow

1. **Start Run**: The CLI creates a new thread and run with unique IDs
2. **Send Message**: Your message is sent to the server endpoint
3. **Stream Events**: The CLI connects to the SSE stream and processes events:
   - `RUN_STARTED`: Confirms the run has begun
   - `MESSAGES_SNAPSHOT`: Updates the conversation state
   - `Tool Calls`: If the server requests tool execution
   - `RUN_FINISHED`: Indicates completion
4. **Handle Tools**: When tool calls are received:
   - Interactive mode: Prompts you for tool results
   - Auto mode (`-a`): Generates deterministic results
5. **Continue Flow**: Tool results are sent back, continuing the conversation

## Expected Output

### Interactive Mode

```
$ dart run ag_ui_example -m "Create a haiku"
📍 Starting Tool Based Generative UI flow
📍 Starting run with thread_id: thread_1234567890, run_id: run_1234567890
📍 User message: Create a haiku
📨 runStarted
📍 Run started: run_1234567890
📨 messagesSnapshot
📍 Tool call: generate_haiku

Tool "generate_haiku" was called with:
{"japanese":["エーアイの","橋つなぐ道","コパキット"],"english":["From AI's realm","A bridge-road linking us—","CopilotKit."]}
Enter tool result (or press Enter for default):
thanks

📍 Sending tool result to server...
📨 messagesSnapshot
🤖 Haiku created
📨 runFinished
📍 Run finished: run_1234567890
```

### Auto Mode

```
$ dart run ag_ui_example -a -m "Create a haiku"
📍 Starting Tool Based Generative UI flow
📍 Starting run with thread_id: thread_1234567890, run_id: run_1234567890
📍 User message: Create a haiku
📨 runStarted
📍 Run started: run_1234567890
📨 messagesSnapshot
📍 Tool call: generate_haiku
📍 Auto-generated tool result: thanks
📍 Sending tool result to server...
📨 messagesSnapshot
🤖 Haiku created
📨 runFinished
📍 Run finished: run_1234567890
```

## Troubleshooting

### Server Connection Issues

If you see connection errors:
1. Verify the server is running: `curl http://127.0.0.1:20203/health`
2. Check the server URL matches: Use `-u` flag or `AG_UI_BASE_URL` env var
3. Check firewall/network settings

### Decoding Errors

If events fail to decode:
1. Use JSON output mode (`-j`) to see raw event data
2. Enable debug logging: `DEBUG=true dart run ag_ui_example`
3. Verify server is using compatible AG-UI protocol version

### Tool Call Issues

If tool calls aren't working:
1. In interactive mode, ensure you're providing valid JSON if needed
2. Use auto mode (`-a`) to test with known-good responses
3. Check server logs for tool execution errors

## Development

### Running Tests

```bash
dart test
```

### Code Analysis

```bash
dart analyze
```

### Formatting

```bash
dart format .
```

## Architecture

The example demonstrates:
- **AgUiClient**: HTTP client for AG-UI endpoints
- **SseClient**: Server-sent events streaming
- **EventDecoder**: Deserializing protocol events
- **Message/ToolCall Models**: Strongly-typed protocol objects
- **Error Handling**: Graceful degradation and user feedback