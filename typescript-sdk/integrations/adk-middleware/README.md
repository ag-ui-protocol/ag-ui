# ADK Middleware for AG-UI Protocol

This Python middleware enables Google ADK agents to be used with the AG-UI Protocol, providing a seamless bridge between the two frameworks.

## Features

- ⚠️ Full event translation between AG-UI and ADK (partial - full support coming soon)
- ✅ Automatic session management with configurable timeouts
- ✅ Automatic session memory option - expired sessions automatically preserved in ADK memory service
- ✅ Support for multiple agents with centralized registry
- ❌ State synchronization between protocols (coming soon)
- ❌ Tool/function calling support (coming soon)
- ✅ Streaming responses with SSE
- ✅ Multi-user support with session isolation

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

# Install this package in editable mode
pip install -e .

# For development (includes testing and linting tools)
pip install -e ".[dev]"
# OR
pip install -r requirements-dev.txt
```

This installs the ADK middleware in editable mode for development.

## Directory Structure Note

Although this is a Python integration, it lives in `typescript-sdk/integrations/` following the ag-ui-protocol repository conventions where all integrations are centralized regardless of implementation language.

## Quick Start

### Option 1: Direct Usage
```python
from adk_middleware import ADKAgent, AgentRegistry
from google.adk.agents import Agent

# 1. Create your ADK agent
my_agent = Agent(
    name="assistant",
    instruction="You are a helpful assistant."
)

# 2. Register the agent
registry = AgentRegistry.get_instance()
registry.set_default_agent(my_agent)

# 3. Create the middleware
agent = ADKAgent(app_name="my_app", user_id="user123")

# 4. Use directly with AG-UI RunAgentInput
async for event in agent.run(input_data):
    print(f"Event: {event.type}")
```

### Option 2: FastAPI Server
```python
from fastapi import FastAPI
from adk_middleware import ADKAgent, AgentRegistry, add_adk_fastapi_endpoint
from google.adk.agents import Agent

# Set up agent and registry (same as above)
registry = AgentRegistry.get_instance()
registry.set_default_agent(my_agent)
agent = ADKAgent(app_name="my_app", user_id="user123")

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
    return Agent(name=agent_id, instruction="You are a helpful assistant.")

registry.set_agent_factory(create_agent)
```

### App and User Identification

```python
# Static app name and user ID (single-tenant apps)
agent = ADKAgent(app_name="my_app", user_id="static_user")

# Dynamic extraction from context (recommended for multi-tenant)
def extract_app(input: RunAgentInput) -> str:
    # Extract from context
    for ctx in input.context:
        if ctx.description == "app":
            return ctx.value
    return "default_app"

def extract_user(input: RunAgentInput) -> str:
    # Extract from context
    for ctx in input.context:
        if ctx.description == "user":
            return ctx.value
    return f"anonymous_{input.thread_id}"

agent = ADKAgent(
    app_name_extractor=extract_app,
    user_id_extractor=extract_user
)
```

### Session Management

Session management is handled automatically by the singleton `SessionLifecycleManager`. The middleware uses sensible defaults, but you can configure session behavior if needed by accessing the session manager directly:

```python
from session_manager import SessionLifecycleManager

# Session management is automatic, but you can access the manager if needed
session_mgr = SessionLifecycleManager.get_instance()

# Create your ADK agent normally
agent = ADKAgent(
    app_name="my_app",
    user_id="user123",
    use_in_memory_services=True
)
```

### Service Configuration

```python
# Development (in-memory services) - Default
agent = ADKAgent(
    app_name="my_app",
    user_id="user123",
    use_in_memory_services=True  # Default behavior
)

# Production with custom services
agent = ADKAgent(
    app_name="my_app", 
    user_id="user123",
    artifact_service=GCSArtifactService(),
    memory_service=VertexAIMemoryService(),  # Enables automatic session memory!
    credential_service=SecretManagerService(),
    use_in_memory_services=False
)
```

### Automatic Session Memory

When you provide a `memory_service`, the middleware automatically preserves expired sessions in ADK's memory service before deletion. This enables powerful conversation history and context retrieval features.

```python
from google.adk.memory import VertexAIMemoryService

# Enable automatic session memory
agent = ADKAgent(
    app_name="my_app",
    user_id="user123", 
    memory_service=VertexAIMemoryService(),  # Sessions auto-saved here on expiration
    use_in_memory_services=False
)

# Now when sessions expire (default 20 minutes), they're automatically:
# 1. Added to memory via memory_service.add_session_to_memory()
# 2. Then deleted from active session storage
# 3. Available for retrieval and context in future conversations
```

**Benefits:**
- **Zero-config**: Works automatically when a memory service is provided
- **Comprehensive**: Applies to all session deletions (timeout, user limits, manual)
- **Performance**: Preserves conversation history without manual intervention

## Examples

### Simple Conversation

```python
import asyncio
from adk_middleware import ADKAgent, AgentRegistry
from google.adk.agents import Agent
from ag_ui.core import RunAgentInput, UserMessage

async def main():
    # Setup
    registry = AgentRegistry.get_instance()
    registry.set_default_agent(
        Agent(name="assistant", instruction="You are a helpful assistant.")
    )
    
    agent = ADKAgent(app_name="demo_app", user_id="demo")
    
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
    app_name="demo_app",
    user_id="demo"  # Or use user_id_extractor for dynamic extraction
)
```

## Event Translation

The middleware translates between AG-UI and ADK event formats:

| AG-UI Event | ADK Event | Description |
|-------------|-----------|-------------|
| TEXT_MESSAGE_* | Event with content.parts[].text | Text messages |
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