# ADK Middleware for AG-UI Protocol

This Python middleware enables Google ADK agents to be used with the AG-UI Protocol, providing a seamless bridge between the two frameworks.

## Features

- ⚠️ Full event translation between AG-UI and ADK (partial - full support coming soon)
- ✅ Automatic session management with configurable timeouts
- ✅ Automatic session memory option - expired sessions automatically preserved in ADK memory service
- ✅ Support for multiple agents with centralized registry
- ❌ State synchronization between protocols (coming soon)
- ✅ **Complete bidirectional tool support** - Enable AG-UI Protocol tools within Google ADK agents
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

Session management is handled automatically by the singleton `SessionManager`. The middleware uses sensible defaults, but you can configure session behavior if needed by accessing the session manager directly:

```python
from adk_middleware.session_manager import SessionManager

# Session management is automatic, but you can access the manager if needed
session_mgr = SessionManager.get_instance()

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

## Tool Support

The middleware provides complete bidirectional tool support, enabling AG-UI Protocol tools to execute within Google ADK agents through an advanced asynchronous architecture.

### Key Features

- **Background Execution**: ADK agents run in asyncio tasks while client handles tools concurrently
- **Asynchronous Communication**: Queue-based communication prevents deadlocks
- **Comprehensive Timeouts**: Both execution-level (600s default) and tool-level (300s default) timeouts
- **Concurrent Limits**: Configurable maximum concurrent executions with automatic cleanup
- **Production Ready**: Robust error handling and resource management

### Tool Configuration

```python
from adk_middleware import ADKAgent, AgentRegistry
from google.adk.agents import LlmAgent
from ag_ui.core import RunAgentInput, UserMessage, Tool

# 1. Create practical business tools using AG-UI Tool schema
task_approval_tool = Tool(
    name="generate_task_steps",
    description="Generate a list of task steps for user approval",
    parameters={
        "type": "object",
        "properties": {
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "description": {"type": "string", "description": "Step description"},
                        "status": {
                            "type": "string", 
                            "enum": ["enabled", "disabled", "executing"],
                            "description": "Step status"
                        }
                    },
                    "required": ["description", "status"]
                }
            }
        },
        "required": ["steps"]
    }
)

document_generator_tool = Tool(
    name="generate_document",
    description="Generate structured documents with approval workflow",
    parameters={
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Document title"},
            "sections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "heading": {"type": "string"},
                        "content": {"type": "string"}
                    }
                }
            },
            "format": {"type": "string", "enum": ["markdown", "html", "plain"]}
        },
        "required": ["title", "sections"]
    }
)

# 2. Set up ADK agent with tool timeouts
agent = LlmAgent(
    name="task_manager_assistant",
    model="gemini-2.0-flash",
    instruction="""You are a helpful task management assistant. When users request task planning,
    use the generate_task_steps tool to create structured task lists for their approval.
    For document creation, use the generate_document tool with proper formatting."""
)

registry = AgentRegistry.get_instance()
registry.set_default_agent(agent)

# 3. Create middleware with tool timeout configuration
adk_agent = ADKAgent(
    user_id="user123",
    tool_timeout_seconds=60,       # Individual tool timeout 
    execution_timeout_seconds=300  # Overall execution timeout
)

# 4. Include tools in RunAgentInput
user_input = RunAgentInput(
    thread_id="thread_123",
    run_id="run_456",
    messages=[UserMessage(
        id="1", 
        role="user", 
        content="Help me plan a project to redesign our company website"
    )],
    tools=[task_approval_tool, document_generator_tool],
    context=[],
    state={},
    forwarded_props={}
)
```

### Tool Execution Flow

```python
async def handle_task_management_workflow():
    """Example showing human-in-the-loop task management."""
    
    tool_events = asyncio.Queue()
    
    async def agent_execution_task():
        """Background agent execution."""
        async for event in adk_agent.run(user_input):
            if event.type == "TOOL_CALL_START":
                print(f"🔧 Tool call: {event.tool_call_name}")
            elif event.type == "TEXT_MESSAGE_CONTENT":
                print(f"💬 Assistant: {event.delta}", end="", flush=True)
    
    async def tool_handler_task():
        """Handle tool execution with human approval."""
        while True:
            tool_info = await tool_events.get()
            if tool_info is None:
                break
                
            tool_call_id = tool_info["tool_call_id"]
            tool_name = tool_info["tool_name"] 
            args = tool_info["args"]
            
            if tool_name == "generate_task_steps":
                # Simulate human-in-the-loop approval
                result = await handle_task_approval(args)
            elif tool_name == "generate_document":
                # Simulate document generation with review
                result = await handle_document_generation(args)
            else:
                result = {"error": f"Unknown tool: {tool_name}"}
            
            # Submit result back to agent
            success = await adk_agent.submit_tool_result(tool_call_id, result)
            print(f"✅ Tool result submitted: {success}")
    
    # Run both tasks concurrently
    await asyncio.gather(
        asyncio.create_task(agent_execution_task()),
        asyncio.create_task(tool_handler_task())
    )

async def handle_task_approval(args):
    """Simulate human approval workflow for task steps."""
    steps = args.get("steps", [])
    
    print("\n📋 Task Steps Generated - Awaiting Approval:")
    for i, step in enumerate(steps):
        status_icon = "✅" if step["status"] == "enabled" else "❌"
        print(f"  {i+1}. {status_icon} {step['description']}")
    
    # In a real implementation, this would wait for user interaction
    # Here we simulate approval after a brief delay
    await asyncio.sleep(1)
    
    return {
        "approved": True,
        "selected_steps": [step for step in steps if step["status"] == "enabled"],
        "message": "Task steps approved by user"
    }

async def handle_document_generation(args):
    """Simulate document generation with review."""
    title = args.get("title", "Untitled Document")
    sections = args.get("sections", [])
    format_type = args.get("format", "markdown")
    
    print(f"\n📄 Document Generated: {title}")
    print(f"   Format: {format_type}")
    print(f"   Sections: {len(sections)}")
    
    # Simulate document creation processing
    await asyncio.sleep(0.5)
    
    return {
        "document_id": f"doc_{int(time.time())}",
        "title": title,
        "sections_count": len(sections),
        "format": format_type,
        "status": "generated",
        "review_required": True
    }
```

### Advanced Tool Features

#### Human-in-the-Loop Tools
Perfect for workflows requiring human approval, review, or input:

```python
# Tools that pause execution for human interaction
approval_tools = [
    Tool(name="request_approval", description="Request human approval for actions"),
    Tool(name="collect_feedback", description="Collect user feedback on generated content"),
    Tool(name="review_document", description="Submit document for human review")
]
```

#### Generative UI Tools  
Enable dynamic UI generation based on tool results:

```python
# Tools that generate UI components
ui_generation_tools = [
    Tool(name="generate_form", description="Generate dynamic forms"),
    Tool(name="create_dashboard", description="Create data visualization dashboards"),
    Tool(name="build_workflow", description="Build interactive workflow UIs")
]
```

### Complete Tool Example

See `examples/comprehensive_tool_demo.py` for a complete working example that demonstrates:
- Single tool usage with realistic business scenarios
- Multi-tool workflows with human approval steps  
- Complex document generation and review processes
- Error handling and timeout management
- Proper asynchronous patterns for production use

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
pytest --cov=src/adk_middleware

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