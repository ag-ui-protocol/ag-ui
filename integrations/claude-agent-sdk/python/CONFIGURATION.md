# Configuration Guide

This document describes configuration options for the Claude Agent SDK integration.

## ClaudeAgent Configuration

### Basic Configuration

```python
from ag_ui_claude import ClaudeAgent
from claude_agent_sdk import ClaudeAgentOptions

# Simple configuration
agent = ClaudeAgent(
    app_name="my_app",
    use_persistent_sessions=True  # Use ClaudeSDKClient
)

# With ClaudeAgentOptions
agent = ClaudeAgent(
    app_name="my_app",
    use_persistent_sessions=True,
    claude_options=ClaudeAgentOptions(
        system_prompt="You are a helpful assistant",
        permission_mode='acceptEdits',
        cwd="/path/to/workspace"
    )
)
```

**Note**: The `api_key` parameter is optional. Claude Agent SDK uses `ANTHROPIC_API_KEY` environment variable by default.

### Session Mode

**Persistent Sessions** (Recommended for multi-turn conversations):
```python
agent = ClaudeAgent(
    api_key="your-api-key",
    use_persistent_sessions=True,  # Use ClaudeSDKClient
    app_name="my_app"
)
```

**Stateless Mode** (For simple queries):
```python
agent = ClaudeAgent(
    api_key="your-api-key",
    use_persistent_sessions=False,  # Use query() method
    app_name="my_app"
)
```

### Dynamic App/User Identification

```python
def extract_app_name(input: RunAgentInput) -> str:
    return input.context.get("app_name", "default")

def extract_user_id(input: RunAgentInput) -> str:
    return input.forwarded_props.get("user_id", "anonymous")

agent = ClaudeAgent(
    api_key="your-api-key",
    app_name_extractor=extract_app_name,
    user_id_extractor=extract_user_id
)
```

### Timeout Configuration

```python
agent = ClaudeAgent(
    api_key="your-api-key",
    execution_timeout_seconds=600,  # 10 minutes (default)
    tool_timeout_seconds=300,        # 5 minutes (default)
    session_timeout_seconds=1200,   # 20 minutes (default)
    cleanup_interval_seconds=300    # 5 minutes (default)
)
```

### Concurrency Limits

```python
agent = ClaudeAgent(
    api_key="your-api-key",
    max_concurrent_executions=10  # Default: 10
)
```

### Additional Claude SDK Options

```python
from claude_agent_sdk import ClaudeAgentOptions

# Configure via ClaudeAgentOptions
options = ClaudeAgentOptions(
    system_prompt="You are an expert Python developer",
    permission_mode='acceptEdits',
    allowed_tools=["Read", "Write", "Bash"],
    cwd="/home/user/project",
    # ... other options
)

agent = ClaudeAgent(
    app_name="my_app",
    claude_options=options
)
```

See the [Claude Agent SDK documentation](https://docs.claude.com/zh-CN/api/agent-sdk/python#claudeagentoptions) for all available options.

## FastAPI Endpoint Configuration

### Basic Setup

```python
from fastapi import FastAPI
from ag_ui_claude import ClaudeAgent, add_claude_fastapi_endpoint

app = FastAPI()
agent = ClaudeAgent(api_key="your-api-key")
add_claude_fastapi_endpoint(app, agent, path="/chat")
```

### Custom Path

```python
add_claude_fastapi_endpoint(app, agent, path="/api/v1/claude")
```

### Standalone App

```python
from ag_ui_claude import ClaudeAgent, create_claude_app

agent = ClaudeAgent(api_key="your-api-key")
app = create_claude_app(agent, path="/chat")
```

## Environment Variables

### Required Variables

Claude Agent SDK supports multiple authentication methods:

**Option 1: Using AUTH_TOKEN and BASE_URL (recommended)**
- `ANTHROPIC_AUTH_TOKEN`: Authentication token for Claude API
- `ANTHROPIC_BASE_URL`: Base URL for Claude API (e.g., `https://api.anthropic.com`)

**Option 2: Using API Key (fallback)**
- `ANTHROPIC_API_KEY`: Claude API key

**Important**: Claude Agent SDK requires at least one authentication method to be set. The SDK will use `ANTHROPIC_AUTH_TOKEN` if available, otherwise fall back to `ANTHROPIC_API_KEY`.

### Optional Variables

- `LOG_ROOT_LEVEL`: Root logging level (e.g., "DEBUG", "INFO")
- `LOG_CLAUDE_AGENT`: ClaudeAgent logger level
- `LOG_EVENT_TRANSLATOR`: EventTranslator logger level

### Configuration via .env.local File

For development and testing, you can use a `.env.local` file to configure environment variables:

1. Copy the example file:
   ```bash
   cp .env.local.example .env.local
   ```

2. Edit `.env.local` and add your configuration:
   ```bash
   # Option 1: Using AUTH_TOKEN and BASE_URL
   ANTHROPIC_AUTH_TOKEN=your-auth-token-here
   ANTHROPIC_BASE_URL=https://api.anthropic.com
   
   # Option 2: Using API Key
   # ANTHROPIC_API_KEY=your-api-key-here
   
   LOG_ROOT_LEVEL=DEBUG
   ```

3. The `.env.local` file is automatically loaded:
   - **In tests**: Automatically loaded by `conftest.py` using `python-dotenv`
   - **In application code**: You can manually load it:
     ```python
     from dotenv import load_dotenv
     load_dotenv('.env.local')
     ```

**Note**: `.env.local` is gitignored and should not be committed. Always use `.env.local.example` as a template.

### Alternative: Direct Environment Variable

You can also set environment variables directly:

```bash
# Linux/macOS - Option 1: AUTH_TOKEN and BASE_URL
export ANTHROPIC_AUTH_TOKEN=your-auth-token-here
export ANTHROPIC_BASE_URL=https://api.anthropic.com

# Linux/macOS - Option 2: API Key
export ANTHROPIC_API_KEY=your-api-key-here

# Windows (PowerShell) - Option 1: AUTH_TOKEN and BASE_URL
$env:ANTHROPIC_AUTH_TOKEN="your-auth-token-here"
$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"

# Windows (PowerShell) - Option 2: API Key
$env:ANTHROPIC_API_KEY="your-api-key-here"

# Windows (CMD) - Option 1: AUTH_TOKEN and BASE_URL
set ANTHROPIC_AUTH_TOKEN=your-auth-token-here
set ANTHROPIC_BASE_URL=https://api.anthropic.com

# Windows (CMD) - Option 2: API Key
set ANTHROPIC_API_KEY=your-api-key-here
```

## Session Management

### Session Cleanup

Sessions are automatically cleaned up after `session_timeout_seconds` of inactivity. Sessions with pending tool calls are preserved.

### Custom Session Manager

```python
from ag_ui_claude import SessionManager

# Get singleton instance
session_manager = SessionManager.get_instance(
    session_timeout_seconds=1800,  # 30 minutes
    cleanup_interval_seconds=600,  # 10 minutes
    max_sessions_per_user=5,       # Limit sessions per user
    auto_cleanup=True
)
```

## Error Handling

Errors are automatically converted to `RunErrorEvent` and streamed to the client. Error codes include:

- `EXECUTION_ERROR`: General execution error
- `EXECUTION_TIMEOUT`: Execution exceeded timeout
- `NO_TOOL_RESULTS`: Tool result submission without results
- `ENCODING_ERROR`: Event encoding failure
- `AGENT_ERROR`: Agent execution failure
- `BACKGROUND_EXECUTION_ERROR`: Background task error

## Best Practices

1. **Use persistent sessions** for multi-turn conversations
2. **Set appropriate timeouts** based on your use case
3. **Monitor concurrent executions** to avoid resource exhaustion
4. **Handle errors gracefully** in your client code
5. **Use environment variables** for sensitive configuration

## Troubleshooting

### API Key Issues
- Ensure `ANTHROPIC_API_KEY` is set or provided in code
- Verify API key is valid and has sufficient quota

### Timeout Issues
- Increase `execution_timeout_seconds` for long-running operations
- Check network connectivity and Claude API status

### Session Issues
- Sessions are automatically cleaned up after timeout
- Use session keys consistently for same conversation

### Tool Issues
- Ensure tool definitions match Claude SDK format
- Check tool call/result message format

