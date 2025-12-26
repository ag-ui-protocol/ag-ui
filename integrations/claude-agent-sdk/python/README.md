# Claude Agent SDK Middleware for AG-UI Protocol

This Python middleware enables [Anthropic Claude Agent SDK](https://docs.claude.com/api/agent-sdk/python) agents to be used with the AG-UI Protocol, providing a bridge between the two frameworks.

## Prerequisites

- Python 3.9 or higher
- An [Anthropic API Key](https://console.anthropic.com/). The examples assume that this is exported via the `ANTHROPIC_API_KEY` environment variable.

## Quick Start

To use this integration you need to:

1. Clone the [AG-UI repository](https://github.com/ag-ui-protocol/ag-ui).

    ```bash
    git clone https://github.com/ag-ui-protocol/ag-ui.git
    ```

2. Change to the `integrations/claude-agent-sdk/python` directory.

    ```bash
    cd integrations/claude-agent-sdk/python
    ```

3. Install the `claude-agent-sdk` middleware package from the local directory. For example,

    ```bash
    pip install .
    ```

    or

    ```bash
    uv pip install .
    ```

    This installs the package from the current directory which contains:
    - `src/ag_ui_claude/` - The middleware source code
    - `examples/` - Example servers and agents
    - `tests/` - Test suite

4. Set your Anthropic API key:

    ```bash
    export ANTHROPIC_API_KEY=your-api-key-here
    ```

5. Run the example FastAPI server:

    ```bash
    cd examples/server
    python fastapi_server.py
    ```

    Or use uvicorn directly:

    ```bash
    uvicorn examples.server.fastapi_server:app --host 0.0.0.0 --port 8000
    ```

### Development Setup

If you want to contribute to Claude Agent SDK Middleware development, you can use the following setup:

```bash
# From the claude-agent-sdk/python directory
# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install this package in editable mode
pip install -e .

# For development (includes testing and linting tools)
pip install -e ".[dev]"
```

This installs the Claude Agent SDK middleware in editable mode for development.

## Testing

### Environment Configuration

For tests that require API access (like `test_real_api.py`), you can configure authentication credentials using a `.env.local` file:

1. Copy the example file:
   ```bash
   cp .env.local.example .env.local
   ```

2. Edit `.env.local` and add your authentication credentials:

   **Option 1: Using AUTH_TOKEN and BASE_URL (recommended)**
   ```bash
   ANTHROPIC_AUTH_TOKEN=your-auth-token-here
   ANTHROPIC_BASE_URL=https://api.anthropic.com
   ```

   **Option 2: Using API Key (fallback)**
   ```bash
   ANTHROPIC_API_KEY=your-api-key-here
   ```

3. The `.env.local` file will be automatically loaded when running tests (via `python-dotenv`).

**Note**: `.env.local` is gitignored and should not be committed. The `.env.local.example` file serves as a template.

Alternatively, you can set the environment variables directly:
```bash
# Option 1: AUTH_TOKEN and BASE_URL
export ANTHROPIC_AUTH_TOKEN=your-auth-token-here
export ANTHROPIC_BASE_URL=https://api.anthropic.com

# Option 2: API Key
export ANTHROPIC_API_KEY=your-api-key-here
```

### Running Tests

```bash
# Run tests (72 comprehensive tests)
pytest

# With coverage
pytest --cov=src/ag_ui_claude

# Specific test file
pytest tests/test_claude_agent.py

# Run only real API tests (requires ANTHROPIC_API_KEY)
pytest tests/test_real_api.py -m integration
```

## Usage Options

### Option 1: Direct Usage

```python
from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage
from claude_agent_sdk import ClaudeAgentOptions

# 1. Create the middleware agent
agent = ClaudeAgent(
    use_persistent_sessions=True,  # Use ClaudeSDKClient for multi-turn conversations
    app_name="my_app",
    user_id="user123",
    claude_options=ClaudeAgentOptions(
        system_prompt="You are a helpful assistant",
        permission_mode='acceptEdits'
    )
)

# 2. Use directly with AG-UI RunAgentInput
input_data = RunAgentInput(
    thread_id="thread_001",
    run_id="run_001",
    messages=[
        UserMessage(id="1", role="user", content="Hello!")
    ],
    context=[],
    state={},
    tools=[],  # AG-UI tools will be converted to Claude SDK tools
    forwarded_props={}
)

async for event in agent.run(input_data):
    print(f"Event: {event.type}")
    if hasattr(event, 'delta'):
        print(f"Content: {event.delta}")
```

### Option 2: FastAPI Server

```python
from fastapi import FastAPI
from ag_ui_claude import ClaudeAgent, add_claude_fastapi_endpoint
from claude_agent_sdk import ClaudeAgentOptions

# 1. Create the middleware agent
agent = ClaudeAgent(
    use_persistent_sessions=True,
    app_name="my_app",
    claude_options=ClaudeAgentOptions(
        system_prompt="You are a helpful assistant",
        permission_mode='acceptEdits'
    )
)

# 2. Create FastAPI app
app = FastAPI()
add_claude_fastapi_endpoint(app, agent, path="/chat")

# Run with: uvicorn your_module:app --host 0.0.0.0 --port 8000
```

**Note**: The Claude Agent SDK uses the `ANTHROPIC_API_KEY` environment variable by default. Set it before running:

```bash
export ANTHROPIC_API_KEY=your-api-key-here
```

For detailed configuration options, see [CONFIGURATION.md](./CONFIGURATION.md)

## Examples

### Simple Conversation

```python
import asyncio
from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage
from claude_agent_sdk import ClaudeAgentOptions

async def main():
    # Setup
    agent = ClaudeAgent(
        use_persistent_sessions=True,
        app_name="demo_app",
        user_id="demo",
        claude_options=ClaudeAgentOptions(
            system_prompt="You are a helpful assistant."
        )
    )

    # Create input
    input = RunAgentInput(
        thread_id="thread_001",
        run_id="run_001",
        messages=[
            UserMessage(id="1", role="user", content="Hello!")
        ],
        context=[],
        state={},
        tools=[],
        forwarded_props={}
    )

    # Run and handle events
    async for event in agent.run(input):
        print(f"Event: {event.type}")
        if hasattr(event, 'delta'):
            print(f"Content: {event.delta}")

asyncio.run(main())
```

### With Tools

```python
from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage, Tool, EventType

# Define a tool
weather_tool = Tool(
    name="get_current_weather",
    description="Get the current weather in a given location",
    parameters={
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "The city and state"},
            "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
        },
        "required": ["location"]
    }
)

agent = ClaudeAgent(
    use_persistent_sessions=True,
    app_name="my_app"
)

input_data = RunAgentInput(
    thread_id="thread_001",
    run_id="run_001",
    messages=[
        UserMessage(id="1", role="user", content="What's the weather in London?")
    ],
    tools=[weather_tool],  # Tools are automatically converted to Claude SDK format
    state={},
    context=[],
    forwarded_props={}
)

async for event in agent.run(input_data):
    if event.type == EventType.TOOL_CALL_START:
        print(f"Tool call: {event.tool_call_name}")
    elif event.type == EventType.TEXT_MESSAGE_CONTENT:
        print(f"Response: {event.delta}")
```

### Stateless Mode

```python
from ag_ui_claude import ClaudeAgent

# Use stateless mode for simple one-off queries
agent = ClaudeAgent(
    use_persistent_sessions=False,  # Uses query() function
    app_name="stateless_app"
)

# Each query is independent, no conversation history
async for event in agent.run(input_data):
    print(f"Event: {event.type}")
```

## Tool Support

The middleware provides complete bidirectional tool support, enabling AG-UI Protocol tools to execute within Claude Agent SDK agents. All tools supplied by the client are currently implemented as long-running tools that emit events to the client for execution and can be combined with backend tools provided by the agent to create a hybrid combined toolset.

AG-UI tools are automatically converted to Claude SDK `SdkMcpTool` format and exposed via MCP servers. When Claude requests a tool, the middleware emits AG-UI `ToolCall` events for client-side execution. Tool results from the client are then formatted and sent back to Claude in subsequent requests.

## Configuration

### ClaudeAgent Parameters

- `api_key`: Claude API key (optional, defaults to `ANTHROPIC_API_KEY` env var)
- `use_persistent_sessions`: Use `ClaudeSDKClient` for persistent sessions (True) or `query()` for stateless mode (False)
- `app_name`: Static application name for all requests
- `user_id`: Static user ID for all requests
- `claude_options`: `ClaudeAgentOptions` instance for SDK configuration
- `execution_timeout_seconds`: Timeout for entire execution (default: 600)
- `max_concurrent_executions`: Maximum concurrent executions (default: 10)
- `session_timeout_seconds`: Session timeout in seconds (default: 1200)
- `cleanup_interval_seconds`: Session cleanup interval (default: 300)

**ClaudeAgentOptions** supports many configuration options:
- `system_prompt`: System prompt for the agent
- `permission_mode`: Permission mode ('acceptEdits', 'promptEdits', etc.)
- `allowed_tools`: List of allowed tool names
- `mcp_servers`: MCP server configurations
- `cwd`: Working directory for file operations
- `max_tokens`: Maximum tokens for responses
- `temperature`: Temperature for response generation
- And more - see [Claude Agent SDK documentation](https://docs.claude.com/api/agent-sdk/python)

See [CONFIGURATION.md](./CONFIGURATION.md) for detailed configuration options.

## Features

- **Event Streaming**: Real-time streaming of agent responses via Server-Sent Events (SSE)
- **Tool Support**: Both client-side and backend tool execution via MCP servers
- **Session Management**: Automatic session cleanup and state management
- **Message Tracking**: Avoids duplicate message processing
- **Error Handling**: Comprehensive error handling and reporting
- **Persistent Sessions**: Support for multi-turn conversations via `ClaudeSDKClient`
- **Stateless Mode**: Support for one-off queries via `query()` function

## Implementation Status

✅ **Core Implementation Complete**: The integration has been updated based on the [Claude Agent SDK documentation](https://docs.claude.com/api/agent-sdk/python#claudesdkclient).

Key features implemented:
- ✅ `ClaudeSDKClient` integration for persistent sessions
- ✅ `query()` function support for stateless mode
- ✅ Message translation (`AssistantMessage`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`)
- ✅ Tool support via MCP servers (`SdkMcpTool`, `create_sdk_mcp_server`)
- ✅ Streaming response handling
- ✅ Session management with automatic cleanup
- ✅ Comprehensive test suite (72 tests, 65% pass rate)

The implementation follows the actual Claude Agent SDK API patterns. Some areas may need fine-tuning based on real-world usage:
- Tool execution flow (client vs backend tools)
- Message history handling in persistent sessions
- Error handling for specific SDK error types

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation.

## Additional Documentation

- **[USAGE_GUIDE.md](./USAGE_GUIDE.md)** - Complete usage guide: how to start and test the agent
- **[CONFIGURATION.md](./CONFIGURATION.md)** - Complete configuration guide
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Technical architecture and design details
- **[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md)** - Current implementation status and test results
- **[IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)** - Implementation plan and roadmap

## Contributing

Contributions are welcome! Please refer to the main AG-UI contributing guidelines.

## License

MIT License - see LICENSE file for details.

