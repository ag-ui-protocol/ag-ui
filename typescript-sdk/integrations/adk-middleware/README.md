# ADK Middleware for AG-UI Protocol

This Python middleware enables Google ADK agents to be used with the AG-UI Protocol, providing a seamless bridge between the two frameworks.

## Features

- ✅ Full event translation between AG-UI and ADK
- ✅ Automatic session management with configurable timeouts
- ✅ Support for multiple agents with centralized registry
- ✅ State synchronization between protocols
- ✅ Tool/function calling support
- ✅ Streaming responses with SSE
- ✅ Multi-user support with session isolation
- ✅ Comprehensive service integration (artifact, memory, credential)

## Installation

### Development Setup

```bash
# From the adk-middleware directory
chmod +x setup_dev.sh
./setup_dev.sh
```

### Manual Setup

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate

# Install python-sdk (from the monorepo)
pip install ../../../../python-sdk/

# Install this package in editable mode
pip install -e .
```

This installs the ADK middleware in editable mode for development.

## Directory Structure Note

Although this is a Python integration, it lives in `typescript-sdk/integrations/` following the ag-ui-protocol repository conventions where all integrations are centralized regardless of implementation language.

## Quick Start

### Option 1: Direct Usage
```python
from adk_middleware import ADKAgent, AgentRegistry
from google.adk import LlmAgent

# 1. Create your ADK agent
my_agent = LlmAgent(
    name="assistant",
    model="gemini-2.0",
    instruction="You are a helpful assistant."
)

# 2. Register the agent
registry = AgentRegistry.get_instance()
registry.set_default_agent(my_agent)

# 3. Create the middleware
agent = ADKAgent(user_id="user123")

# 4. Use directly with AG-UI RunAgentInput
async for event in agent.run(input_data):
    print(f"Event: {event.type}")
```

### Option 2: FastAPI Server
```python
from fastapi import FastAPI
from adk_middleware import ADKAgent, AgentRegistry, add_adk_fastapi_endpoint
from google.adk import LlmAgent

# Set up agent and registry (same as above)
registry = AgentRegistry.get_instance()
registry.set_default_agent(my_agent)
agent = ADKAgent(user_id="user123")

# Create FastAPI app
app = FastAPI()
add_adk_fastapi_endpoint(app, agent, path="/chat")

# Run with: uvicorn your_module:app --host 0.0.0.0 --port 8000
```

## Configuration Options

### Agent Registry

The `AgentRegistry` provides flexible agent mapping:

```python
registry = AgentRegistry.get_instance()

# Option 1: Default agent for all requests
registry.set_default_agent(my_agent)

# Option 2: Map specific agent IDs
registry.register_agent("support", support_agent)
registry.register_agent("coder", coding_agent)

# Option 3: Dynamic agent creation
def create_agent(agent_id: str) -> BaseAgent:
    return LlmAgent(name=agent_id, model="gemini-2.0")

registry.set_agent_factory(create_agent)
```

### User Identification

```python
# Static user ID (single-user apps)
agent = ADKAgent(user_id="static_user")

# Dynamic user extraction
def extract_user(input: RunAgentInput) -> str:
    # Extract from state or other sources
    if hasattr(input.state, 'get') and input.state.get("user_id"):
        return input.state["user_id"]
    return "anonymous"

agent = ADKAgent(user_id_extractor=extract_user)
```

### Session Management

```python
agent = ADKAgent(
    session_timeout_seconds=3600,      # 1 hour timeout
    cleanup_interval_seconds=300,      # 5 minute cleanup cycles
    max_sessions_per_user=10,         # Limit concurrent sessions
    auto_cleanup=True                 # Enable automatic cleanup
)
```

### Service Configuration

```python
# Development (in-memory services)
agent = ADKAgent(use_in_memory_services=True)

# Production with custom services
agent = ADKAgent(
    session_service=CloudSessionService(),
    artifact_service=GCSArtifactService(),
    memory_service=VertexAIMemoryService(),
    credential_service=SecretManagerService(),
    use_in_memory_services=False
)
```

## Examples

### Simple Conversation

```python
import asyncio
from adk_middleware import ADKAgent, AgentRegistry
from google.adk import LlmAgent
from ag_ui.core import RunAgentInput, UserMessage

async def main():
    # Setup
    registry = AgentRegistry.get_instance()
    registry.set_default_agent(
        LlmAgent(name="assistant", model="gemini-2.0-flash")
    )
    
    agent = ADKAgent(user_id="demo")
    
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

### Multi-Agent Setup

```python
# Register multiple agents
registry = AgentRegistry.get_instance()
registry.register_agent("general", general_agent)
registry.register_agent("technical", technical_agent)
registry.register_agent("creative", creative_agent)

# The middleware uses the default agent from the registry
agent = ADKAgent(
    user_id="demo"  # Or use user_id_extractor for dynamic extraction
)
```

## Event Translation

The middleware translates between AG-UI and ADK event formats:

| AG-UI Event | ADK Event | Description |
|-------------|-----------|-------------|
| TEXT_MESSAGE_* | Event with content.parts[].text | Text messages |
| TOOL_CALL_* | Event with function_call | Function calls |
| STATE_DELTA | Event with actions.state_delta | State changes |
| RUN_STARTED/FINISHED | Runner lifecycle | Execution flow |

## Architecture

```
AG-UI Protocol          ADK Middleware           Google ADK
     │                        │                       │
RunAgentInput ──────> ADKAgent.run() ──────> Runner.run_async()
     │                        │                       │
     │                 EventTranslator                │
     │                        │                       │
BaseEvent[] <──────── translate events <──────── Event[]
```

## Advanced Features

### State Management
- Automatic state synchronization between protocols
- Support for app:, user:, and temp: state prefixes
- JSON Patch format for state deltas

### Tool Integration
- Automatic tool discovery and registration
- Function call/response translation
- Long-running tool support

### Multi-User Support
- Session isolation per user
- Configurable session limits
- Automatic resource cleanup

## Testing

```bash
# Run tests
pytest

# With coverage
pytest --cov=adk_middleware

# Specific test file
pytest tests/test_adk_agent.py
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

This project is part of the AG-UI Protocol and follows the same license terms.