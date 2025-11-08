# Claude Agent SDK Example

This example demonstrates how to use the Claude Agent SDK with Express.js to create an AI agent server that follows the AG-UI Protocol.

## Setup

### 1. Configure Environment Variables

Copy the environment variable template file and configure it:

```bash
cd examples
cp env.example .env.local
```

Edit the `.env.local` file and set the required environment variables:

```bash
# Required: Claude API key
ANTHROPIC_API_KEY=your_api_key_here

# Optional configuration
CLAUDE_CLI_PATH=/path/to/claude-agent-sdk/cli/claude  # Claude CLI path
PORT=3000                                              # Server port
APP_NAME=claude-example                                # Application name
SYSTEM_PROMPT=You are a helpful assistant             # System prompt
ENABLE_PERSISTENT_SESSIONS=true                        # Enable persistent sessions
SESSION_TIMEOUT=1800000                                # Session timeout (milliseconds)
PERMISSION_MODE=ask                                    # Permission mode: ask, auto, none
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Run the Server

```bash
pnpm dev
```

The server will start at `http://localhost:3000`.

## API Endpoints

### POST /api/run-agent

Run the agent with a simple conversation.

**Request:**

```json
{
  "agentId": "my_agent",
  "threadId": "thread_123",
  "messages": [
    {
      "id": "msg_1",
      "role": "user",
      "content": "Hello, how are you?"
    }
  ],
  "context": {}
}
```

**Response:** Server-Sent Events (SSE) stream with AG-UI protocol events.

### POST /api/run-agent-with-tools

Run the agent with predefined tools (calculator and weather).

**Request:**

```json
{
  "agentId": "my_agent",
  "threadId": "thread_123",
  "messages": [
    {
      "id": "msg_1",
      "role": "user",
      "content": "What is 42 + 58?"
    }
  ],
  "context": {}
}
```

### POST /api/cleanup

Cleanup all sessions and resources.

## Example Usage with curl

```bash
# Simple conversation
curl -X POST http://localhost:3000/api/run-agent \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test_agent",
    "messages": [
      {"id": "msg_1", "role": "user", "content": "Hello!"}
    ],
    "context": {}
  }'

# With tools
curl -X POST http://localhost:3000/api/run-agent-with-tools \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test_agent",
    "messages": [
      {"id": "msg_1", "role": "user", "content": "Calculate 15 + 27"}
    ],
    "context": {}
  }'
```

## Features Demonstrated

- **Server-Sent Events (SSE)**: Real-time streaming of agent responses
- **Persistent Sessions**: Maintains conversation context across requests
- **Tool Integration**: Example tools (calculator, weather)
- **Error Handling**: Graceful error handling and reporting
- **Graceful Shutdown**: Clean resource cleanup on server stop

## Event Types

The agent emits the following AG-UI protocol events:

- `run_started`: Execution started
- `text_message_start`: Text message begins
- `text_message_content`: Streaming text content
- `text_message_end`: Text message complete
- `tool_call_start`: Tool call begins
- `tool_call_args`: Tool arguments
- `tool_call_end`: Tool call complete
- `tool_call_result`: Tool execution result
- `run_finished`: Execution complete
- `run_error`: Error occurred
