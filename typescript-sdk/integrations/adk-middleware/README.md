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

### Memory Tools Integration

To enable memory functionality in your ADK agents, you need to add Google ADK's memory tools to your agents (not to the ADKAgent middleware):

```python
from google.adk.agents import Agent
from google.adk import tools as adk_tools

# Create agent with memory tools - THIS IS CORRECT
my_agent = Agent(
    name="assistant",
    model="gemini-2.0-flash", 
    instruction="You are a helpful assistant.",
    tools=[adk_tools.preload_memory_tool.PreloadMemoryTool()]  # Add memory tools here
)

# Register the agent
registry = AgentRegistry.get_instance()
registry.set_default_agent(my_agent)

# Create middleware WITHOUT tools parameter - THIS IS CORRECT  
adk_agent = ADKAgent(
    app_name="my_app",
    user_id="user123",
    memory_service=shared_memory_service  # Memory service enables automatic session memory
)
```

**⚠️ Important**: The `tools` parameter belongs to the ADK agent (like `Agent` or `LlmAgent`), **not** to the `ADKAgent` middleware. The middleware automatically handles any tools defined on the registered agents.

### Memory Testing Configuration

For testing memory functionality across sessions, you may want to shorten the default session timeouts:

```python
# Normal production settings (default)
adk_agent = ADKAgent(
    app_name="my_app",
    user_id="user123",
    memory_service=shared_memory_service
    # session_timeout_seconds=1200,    # 20 minutes (default)
    # cleanup_interval_seconds=300     # 5 minutes (default)
)

# Short timeouts for memory testing
adk_agent = ADKAgent(
    app_name="my_app", 
    user_id="user123",
    memory_service=shared_memory_service,
    session_timeout_seconds=60,     # 1 minute for quick testing
    cleanup_interval_seconds=30     # 30 seconds cleanup for quick testing
)
```

**Testing Memory Workflow:**
1. Start a conversation and provide information (e.g., "My name is John")
2. Wait for session timeout + cleanup interval (up to 90 seconds with testing config: 60s timeout + up to 30s for next cleanup cycle)
3. Start a new conversation and ask about the information ("What's my name?") 
4. The agent should remember the information from the previous session

**⚠️ Note**: Always revert to production timeouts (defaults) for actual deployments.

## Tool Support

The middleware provides complete bidirectional tool support, enabling AG-UI Protocol tools to execute within Google ADK agents through an advanced **hybrid execution model** that bridges AG-UI's stateless runs with ADK's stateful execution.

### Hybrid Execution Model

The middleware implements a sophisticated hybrid execution model that solves the fundamental architecture mismatch between AG-UI and ADK:

- **AG-UI Protocol**: Stateless run-based model where each interaction is a separate `RunAgentInput`
- **ADK Agents**: Stateful execution model with continuous conversation context
- **Hybrid Solution**: Paused executions that resume across multiple AG-UI runs

#### Key Features

- **Background Execution**: ADK agents run in asyncio tasks while client handles tools concurrently
- **Execution Resumption**: Paused executions resume when tool results are provided via `ToolMessage`
- **Fire-and-Forget Tools**: Long-running tools return immediately for Human-in-the-Loop workflows
- **Blocking Tools**: Regular tools wait for results with configurable timeouts
- **Mixed Execution Modes**: Per-tool configuration for different execution behaviors in the same toolset
- **Asynchronous Communication**: Queue-based communication prevents deadlocks
- **Comprehensive Timeouts**: Both execution-level (600s default) and tool-level (300s default) timeouts
- **Concurrent Limits**: Configurable maximum concurrent executions with automatic cleanup
- **Production Ready**: Robust error handling and resource management

#### Execution Flow

```
1. Initial AG-UI Run → ADK Agent starts execution
2. ADK Agent requests tool use → Execution pauses, creates tool futures
3. Tool events emitted → Client receives tool call information
4. Client executes tools → Results prepared asynchronously
5. Subsequent AG-UI Run with ToolMessage → Tool futures resolved
6. ADK Agent execution resumes → Continues with tool results
7. Final response → Execution completes
```

### Tool Execution Modes

The middleware supports two distinct execution modes that can be configured per tool:

#### Long-Running Tools (Default: `is_long_running=True`)
**Perfect for Human-in-the-Loop (HITL) workflows**

- **Fire-and-forget pattern**: Returns `None` immediately without waiting
- **No timeout applied**: Execution continues until tool result is provided
- **Ideal for**: User approval workflows, document review, manual input collection
- **ADK Pattern**: Established pattern where tools pause execution for human interaction

```python
# Long-running tool example
approval_tool = Tool(
    name="request_approval",
    description="Request human approval for sensitive operations",
    parameters={"type": "object", "properties": {"action": {"type": "string"}}}
)

# Tool execution returns immediately
result = await proxy_tool.run_async(args, context)  # Returns None immediately
# Client provides result via ToolMessage in subsequent run
```

#### Blocking Tools (`is_long_running=False`)
**For immediate results with timeout protection**

- **Blocking pattern**: Waits for tool result with configurable timeout
- **Timeout applied**: Default 300 seconds, configurable per tool
- **Ideal for**: API calls, calculations, data retrieval
- **Error handling**: TimeoutError raised if no result within timeout

```python
# Blocking tool example  
calculator_tool = Tool(
    name="calculate",
    description="Perform mathematical calculations",
    parameters={"type": "object", "properties": {"expression": {"type": "string"}}}
)

# Tool execution waits for result
result = await proxy_tool.run_async(args, context)  # Waits and returns result
```

### Per-Tool Configuration

The `ClientProxyToolset` supports mixed execution modes within the same toolset:

```python
from adk_middleware.client_proxy_toolset import ClientProxyToolset

# Create toolset with mixed execution modes
toolset = ClientProxyToolset(
    ag_ui_tools=[approval_tool, calculator_tool, weather_tool],
    event_queue=event_queue,
    tool_futures=tool_futures,
    is_long_running=True,  # Default for all tools
    tool_long_running_config={
        "calculate": False,      # Override: calculator should be blocking
        "weather": False,        # Override: weather should be blocking  
        # approval_tool uses default (True - long-running)
    }
)
```

#### Configuration Options

- **`is_long_running`**: Default execution mode for all tools in the toolset
- **`tool_long_running_config`**: Dict mapping tool names to specific `is_long_running` values
- **Per-tool overrides**: Specific tools can override the default behavior
- **Flexible mixing**: Same toolset can contain both long-running and blocking tools

### Tool Configuration

```python
from adk_middleware import ADKAgent, AgentRegistry
from google.adk.agents import LlmAgent
from ag_ui.core import RunAgentInput, UserMessage, Tool

# 1. Create tools with different execution patterns
# Long-running tool for human approval (default behavior)
task_approval_tool = Tool(
    name="request_approval",
    description="Request human approval for task execution",
    parameters={
        "type": "object",
        "properties": {
            "task": {"type": "string", "description": "Task requiring approval"},
            "risk_level": {"type": "string", "enum": ["low", "medium", "high"]}
        },
        "required": ["task"]
    }
)

# Blocking tool for immediate calculation
calculator_tool = Tool(
    name="calculate",
    description="Perform mathematical calculations",
    parameters={
        "type": "object",
        "properties": {
            "expression": {"type": "string", "description": "Mathematical expression"}
        },
        "required": ["expression"]
    }
)

# Blocking tool for API calls
weather_tool = Tool(
    name="get_weather",
    description="Get current weather information",
    parameters={
        "type": "object",
        "properties": {
            "location": {"type": "string", "description": "City name"}
        },
        "required": ["location"]
    }
)

# 2. Set up ADK agent with hybrid tool support
agent = LlmAgent(
    name="hybrid_assistant",
    model="gemini-2.0-flash",
    instruction="""You are a helpful assistant that can request approvals and perform calculations.
    Use request_approval for sensitive operations that need human review.
    Use calculate for math operations and get_weather for weather information."""
)

registry = AgentRegistry.get_instance()
registry.set_default_agent(agent)

# 3. Create middleware with hybrid execution configuration
adk_agent = ADKAgent(
    user_id="user123",
    tool_timeout_seconds=60,       # Timeout for blocking tools only
    execution_timeout_seconds=300, # Overall execution timeout
    # Mixed execution modes configured at toolset level
)

# 4. Include tools in RunAgentInput - execution modes configured automatically
user_input = RunAgentInput(
    thread_id="thread_123",
    run_id="run_456",
    messages=[UserMessage(
        id="1", 
        role="user", 
        content="Calculate 15 * 8 and then request approval for the result"
    )],
    tools=[task_approval_tool, calculator_tool, weather_tool],
    context=[],
    state={},
    forwarded_props={}
)
```

### Hybrid Execution Flow

The hybrid model enables seamless execution across multiple AG-UI runs:

```python
async def demonstrate_hybrid_execution():
    """Example showing hybrid execution with mixed tool types."""
    
    # Step 1: Initial run - starts execution with mixed tools
    print("🚀 Starting hybrid execution...")
    
    initial_events = []
    async for event in adk_agent.run(user_input):
        initial_events.append(event)
        
        if event.type == "TOOL_CALL_START":
            print(f"🔧 Tool call: {event.tool_call_name} (ID: {event.tool_call_id})")
        elif event.type == "TEXT_MESSAGE_CONTENT":
            print(f"💬 Assistant: {event.delta}", end="", flush=True)
    
    print("\n📊 Initial execution completed - tools awaiting results")
    
    # Step 2: Handle tool results based on execution mode
    tool_results = []
    
    # Extract tool calls from events
    for event in initial_events:
        if event.type == "TOOL_CALL_START":
            tool_call_id = event.tool_call_id
            tool_name = event.tool_call_name
            
            if tool_name == "calculate":
                # Blocking tool - would have completed immediately
                result = {"result": 120, "expression": "15 * 8"}
                tool_results.append((tool_call_id, result))
                
            elif tool_name == "request_approval":
                # Long-running tool - requires human interaction
                result = await handle_human_approval(tool_call_id)
                tool_results.append((tool_call_id, result))
    
    # Step 3: Submit tool results and resume execution
    if tool_results:
        print(f"\n🔄 Resuming execution with {len(tool_results)} tool results...")
        
        # Create ToolMessage entries for resumption
        tool_messages = []
        for tool_call_id, result in tool_results:
            tool_messages.append(
                ToolMessage(
                    id=f"tool_{tool_call_id}",
                    role="tool",
                    content=json.dumps(result),
                    tool_call_id=tool_call_id
                )
            )
        
        # Resume execution with tool results
        resume_input = RunAgentInput(
            thread_id=user_input.thread_id,
            run_id=f"{user_input.run_id}_resume",
            messages=tool_messages,
            tools=[],  # No new tools needed
            context=[],
            state={},
            forwarded_props={}
        )
        
        # Continue execution with results
        async for event in adk_agent.run(resume_input):
            if event.type == "TEXT_MESSAGE_CONTENT":
                print(f"💬 Assistant: {event.delta}", end="", flush=True)
            elif event.type == "RUN_FINISHED":
                print(f"\n✅ Execution completed successfully!")

async def handle_human_approval(tool_call_id):
    """Simulate human approval workflow for long-running tools."""
    print(f"\n👤 Human approval requested for call {tool_call_id}")
    print("⏳ Waiting for human input...")
    
    # Simulate user interaction delay
    await asyncio.sleep(2)
    
    return {
        "approved": True,
        "approver": "user123",
        "timestamp": time.time(),
        "comments": "Approved after review"
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

### Real-World Example: Tool-Based Generative UI

The `examples/tool_based_generative_ui/` directory contains an example that integrates with the existing haiku app in the Dojo, demonstrating how to use the hybrid execution model for generative UI applications:

#### Haiku Generator with Image Selection
```python
# Tool for generating haiku with complementary images
haiku_tool = Tool(
    name="generate_haiku",
    description="Generate a traditional Japanese haiku with selected images",
    parameters={
        "type": "object",
        "properties": {
            "japanese_haiku": {
                "type": "string",
                "description": "Traditional 5-7-5 syllable haiku in Japanese"
            },
            "english_translation": {
                "type": "string", 
                "description": "Poetic English translation"
            },
            "selected_images": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Exactly 3 image filenames that complement the haiku"
            },
            "theme": {
                "type": "string",
                "description": "Theme or mood of the haiku"
            }
        },
        "required": ["japanese_haiku", "english_translation", "selected_images"]
    }
)
```

#### Key Features Demonstrated
- **ADK Agent Integration**: ADK agent creates haiku with structured output
- **Structured Tool Output**: Tool returns JSON with haiku, translation, and image selections
- **Generative UI**: Client can dynamically render UI based on tool results

#### Usage Pattern
```python
# 1. User generates request
# 2. ADK agent analyzes request and calls generate_haiku tool
# 3. Tool returns structured data with haiku and image selections
# 4. Client renders UI with haiku text and selected images
# 5. User can request variations or different themes
```

This example showcases the hybrid model for applications where:
- **AI agents** generate structured content
- **Dynamic UI** adapts based on tool output
- **Interactive workflows** allow refinement and iteration
- **Rich media** combines text, images, and user interface elements

### Complete Tool Examples

See the `examples/` directory for comprehensive working examples:

- **`comprehensive_tool_demo.py`**: Complete business workflow example
  - Single tool usage with realistic scenarios
  - Multi-tool workflows with human approval steps  
  - Complex document generation and review processes
  - Error handling and timeout management
  - Proper asynchronous patterns for production use

- **`tool_based_generative_ui/`**: Generative UI example integrating with Dojo
  - Structured output for UI generation
  - Dynamic UI rendering based on tool results
  - Interactive workflows with user refinement
  - Real-world application patterns

## Running the ADK Backend Server for Dojo App

To run the ADK backend server that works with the Dojo app, use the following command:

```bash
python -m examples.fastapi_server
```

This will start a FastAPI server that connects your ADK middleware to the Dojo application.

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