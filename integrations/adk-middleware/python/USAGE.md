# ADK Middleware Usage Guide

This guide provides detailed usage instructions and configuration options for the ADK Middleware.

## Configuration Options

### App and User Identification

```python
# Static app name and user ID (single-tenant apps)
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app", 
    user_id="static_user"
)

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
    adk_agent=my_agent,
    app_name_extractor=extract_app,
    user_id_extractor=extract_user
)
```

### Session Management

Session management is handled automatically by the singleton `SessionManager`. The middleware uses sensible defaults, but you can configure session behavior if needed by accessing the session manager directly:

```python
from ag_ui_adk.session_manager import SessionManager

# Session management is automatic, but you can access the manager if needed
session_mgr = SessionManager.get_instance()

# Create your ADK agent normally
agent = ADKAgent(
    app_name="my_app",
    user_id="user123",
    use_in_memory_services=True
)
```

### Thread ID vs Session ID Mapping

The middleware transparently handles the mapping between AG-UI's `thread_id` and ADK's internal `session_id`:

- **AG-UI `thread_id`**: The client-provided identifier (typically a UUID) that uniquely identifies a conversation thread from the frontend perspective
- **ADK `session_id`**: The backend-generated identifier used by ADK session services (e.g., VertexAI generates numeric IDs)

This mapping is completely transparent to frontend implementations:
- All AG-UI events (`RUN_STARTED`, `RUN_FINISHED`, etc.) use `thread_id`
- The middleware internally maintains a mapping from `thread_id` to `session_id`
- Session state includes metadata (`_ag_ui_thread_id`, `_ag_ui_app_name`, `_ag_ui_user_id`) for recovery after middleware restarts

```python
# Frontend sends thread_id - the backend session_id is handled internally
input = RunAgentInput(
    thread_id="my-uuid-thread-id",  # AG-UI thread identifier
    run_id="run_001",
    messages=[UserMessage(id="1", role="user", content="Hello!")],
    # ...
)

# Events returned to frontend always use thread_id
async for event in agent.run(input):
    # event.thread_id == "my-uuid-thread-id" (not the internal session_id)
    print(f"Event for thread: {event.thread_id}")
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
    memory_service=VertexAIMemoryService(),  
    credential_service=SecretManagerService(),
    use_in_memory_services=False
)
```

### Using App for Full ADK Features

For access to App-level features like resumability, context caching, and plugins,
use the `from_app()` constructor:

```python
from google.adk.apps import App
from google.adk.agents import Agent
from google.adk.plugins.logging_plugin import LoggingPlugin
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

# Create ADK App with plugins and configs
app = App(
    name="my_assistant",
    root_agent=Agent(
        name="assistant",
        model="gemini-2.5-flash",
        instruction="You are a helpful assistant.",
        tools=[
            AGUIToolset(), # Add the tools provided by the AG-UI client
        ]
    ),
    plugins=[LoggingPlugin()],
    # resumability_config=ResumabilityConfig(is_resumable=True),  # Optional
)

# Create ADKAgent from App
agent = ADKAgent.from_app(
    app,
    user_id="demo_user",
    plugin_close_timeout=10.0,  # Optional, requires ADK 1.19+
)

# Use with FastAPI
from fastapi import FastAPI
fastapi_app = FastAPI()
add_adk_fastapi_endpoint(fastapi_app, agent, path="/chat")
```

The `from_app()` constructor enables:
- **Plugin support**: Use ADK plugins like `LoggingPlugin` for debugging and tracing
- **Resumability**: Configure pause/resume workflows for long-running operations
- **Context caching**: Optimize LLM calls with context caching configuration
- **Events compaction**: Configure how events are compacted in the application

Note: The `plugin_close_timeout` parameter requires ADK 1.19.0 or later. On older
versions, the parameter is silently ignored.

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

## Memory Tools Integration

To enable memory functionality in your ADK agents, you need to add Google ADK's memory tools to your agents (not to the ADKAgent middleware):

```python
from google.adk.agents import Agent
from google.adk import tools as adk_tools

# Create agent with memory tools - THIS IS CORRECT
my_agent = Agent(
    name="assistant",
    model="gemini-2.0-flash", 
    instruction="You are a helpful assistant.",
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
        adk_tools.preload_memory_tool.PreloadMemoryTool(), # Add memory tools here
    ]
)

# Create middleware with direct agent embedding
adk_agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    memory_service=shared_memory_service  # Memory service enables automatic session memory
)
```

**⚠️ Important**: The `tools` parameter belongs to the ADK agent (like `Agent` or `LlmAgent`), **not** to the `ADKAgent` middleware. To add agui client tools, use the `AGUIToolset()` as shown above.

**Testing Memory Workflow:**

1. Start a conversation and provide information (e.g., "My name is John")
2. Wait for session timeout + cleanup interval (up to 90 seconds with testing config: 60s timeout + up to 30s for next cleanup cycle)
3. Start a new conversation and ask about the information ("What's my name?").
4. The agent should remember the information from the previous session.

## Examples

### Simple Conversation

```python
import asyncio
from ag_ui_adk import ADKAgent
from google.adk.agents import Agent
from ag_ui.core import RunAgentInput, UserMessage

async def main():
    # Setup
    my_agent = Agent(name="assistant", instruction="You are a helpful assistant.")
    
    agent = ADKAgent(
        adk_agent=my_agent,
        app_name="demo_app", 
        user_id="demo"
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

### Passing Initial State

Pass frontend state to initialize the ADK session before the agent runs:

```python
input = RunAgentInput(
    thread_id="session_001",
    run_id="run_001",
    state={
        "selected_document": "doc-456",
        "user_preferences": {"language": "en", "theme": "dark"},
        "context": {"project_id": "proj-123"}
    },
    messages=[
        UserMessage(id="1", role="user", content="Summarize the selected document")
    ],
    context=[],
    tools=[],
    forwarded_props={}
)

# The agent can now access state.selected_document, state.user_preferences, etc.
async for event in agent.run(input):
    print(f"Event: {event.type}")
```

The `state` field:
- Initializes ADK session state on first request for a `thread_id`
- Syncs/merges with existing state on subsequent requests
- Is accessible to ADK agent tools via `context.session.state`

### Using Context

The `context` field from `RunAgentInput` is automatically passed through to ADK agents.
Context is useful for providing metadata about the current request (user info, preferences,
environment details) that the agent can use for personalization.

Context is accessible in two ways:

#### 1. In Tools via Session State

```python
from google.adk.tools import ToolContext
from ag_ui_adk import CONTEXT_STATE_KEY

def personalized_tool(tool_context: ToolContext) -> str:
    """Access context in a tool via session state."""
    context_items = tool_context.state.get(CONTEXT_STATE_KEY, [])

    user_role = None
    for item in context_items:
        if item["description"] == "user_role":
            user_role = item["value"]
            break

    if user_role == "admin":
        return "Welcome, administrator! You have full access."
    return "Welcome! You have standard access."

# Create agent with the tool
my_agent = Agent(
    name="assistant",
    tools=[personalized_tool]
)
```

#### 2. In Instruction Providers via Session State

```python
from google.adk.agents import LlmAgent
from google.adk.agents.readonly_context import ReadonlyContext
from ag_ui_adk import CONTEXT_STATE_KEY

def context_aware_instructions(ctx: ReadonlyContext) -> str:
    """Dynamic instructions based on context."""
    instructions = "You are a helpful assistant."

    # Access context from session state
    context_items = ctx.state.get(CONTEXT_STATE_KEY, [])

    # Find user's preferred language
    for item in context_items:
        if item["description"] == "preferred_language":
            instructions += f"\nRespond in {item['value']}."
            break

    return instructions

# Create agent with dynamic instructions
my_agent = LlmAgent(
    name="assistant",
    model="gemini-2.0-flash",
    instruction=context_aware_instructions,  # Callable, not string
)
```

#### Example Request with Context

```python
input = RunAgentInput(
    thread_id="session_001",
    run_id="run_001",
    messages=[
        UserMessage(id="1", role="user", content="Hello!")
    ],
    context=[
        Context(description="user_role", value="admin"),
        Context(description="preferred_language", value="Spanish"),
        Context(description="timezone", value="America/New_York"),
    ],
    state={},
    tools=[],
    forwarded_props={}
)

async for event in agent.run(input):
    print(f"Event: {event.type}")
```

#### Alternative: Via RunConfig custom_metadata (ADK 1.22.0+)

For users on ADK 1.22.0 or later, context is also available via `RunConfig.custom_metadata`:

```python
def dynamic_instructions(ctx: ReadonlyContext) -> str:
    instructions = "You are a helpful assistant."

    # Alternative access via custom_metadata (ADK 1.22.0+)
    if ctx.run_config and ctx.run_config.custom_metadata:
        context_items = ctx.run_config.custom_metadata.get('ag_ui_context', [])
        for item in context_items:
            instructions += f"\n- {item['description']}: {item['value']}"

    return instructions
```

**Note:** Session state (`ctx.state.get(CONTEXT_STATE_KEY, [])`) is the recommended approach as it works with all ADK versions and provides a unified access pattern for both tools and instruction providers.

See `examples/other/context_usage.py` for a complete working example.

### Multi-Agent Setup

```python
# Create multiple agent instances with different ADK agents
general_agent_wrapper = ADKAgent(
    adk_agent=general_agent,
    app_name="demo_app",
    user_id="demo"
)

technical_agent_wrapper = ADKAgent(
    adk_agent=technical_agent,
    app_name="demo_app",
    user_id="demo"
)

creative_agent_wrapper = ADKAgent(
    adk_agent=creative_agent,
    app_name="demo_app",
    user_id="demo"
)

# Use different endpoints for each agent
from fastapi import FastAPI
from ag_ui_adk import add_adk_fastapi_endpoint

app = FastAPI()
add_adk_fastapi_endpoint(app, general_agent_wrapper, path="/agents/general")
add_adk_fastapi_endpoint(app, technical_agent_wrapper, path="/agents/technical")
add_adk_fastapi_endpoint(app, creative_agent_wrapper, path="/agents/creative")
```

### Predictive State Updates

Predictive state updates allow the frontend to receive real-time state changes as the model streams tool call arguments. This is particularly useful for live previews — for example, showing a document being written character-by-character before the tool call completes.

The key insight is that LLM tool calls are structurally different from text generation: the model produces a complete JSON blob of arguments, which is normally delivered all at once. Without streaming function call arguments, the frontend receives the entire tool call only after the model finishes generating it, which means no incremental UI updates during potentially long argument generation (e.g., writing a multi-paragraph document into a `document` parameter).

**With streaming function call arguments enabled**, the model sends argument content incrementally as it generates, and the middleware translates each chunk into `TOOL_CALL_ARGS` events. The `predict_state` configuration then watches for a specific tool and argument, emitting `CUSTOM` events with `STATE_DELTA` patches that let the frontend render live content.

#### Basic Setup

```python
from ag_ui_adk import ADKAgent, PredictStateMapping, AGUIToolset
from google.adk.agents import LlmAgent

agent = LlmAgent(
    name="writer",
    model="gemini-2.0-flash",
    instruction="Use write_document to write documents.",
    tools=[write_document, AGUIToolset()],
)

adk_agent = ADKAgent(
    adk_agent=agent,
    app_name="my_app",
    user_id="user123",
    predict_state=[
        PredictStateMapping(
            state_key="document",          # Frontend state key to update
            tool="write_document",         # Tool name to watch
            tool_argument="document",      # Argument to extract
        )
    ],
)
```

Without streaming function call arguments, `predict_state` still works — it just emits a single state update when the complete tool call arrives, rather than incremental updates as the content streams in.

#### Enabling Streaming Function Call Arguments (Gemini 3+)

For true character-by-character streaming, enable `stream_function_call_arguments` on the model and set `streaming_function_call_arguments=True` on `ADKAgent`:

```python
from google.genai import types

generate_config = types.GenerateContentConfig(
    tool_config=types.ToolConfig(
        function_calling_config=types.FunctionCallingConfig(
            stream_function_call_arguments=True
        )
    )
)

agent = LlmAgent(
    name="writer",
    model="gemini-3-flash-preview",
    tools=[write_document, AGUIToolset()],
    generate_content_config=generate_config,
)

adk_agent = ADKAgent(
    adk_agent=agent,
    app_name="my_app",
    user_id="user123",
    streaming_function_call_arguments=True,
    predict_state=[
        PredictStateMapping(
            state_key="document",
            tool="write_document",
            tool_argument="document",
        )
    ],
)
```

Requirements for streaming function call arguments:
- `google-adk >= 1.20.0` with `PROGRESSIVE_SSE_STREAMING` (default in >= 1.22.0)
- Vertex AI credentials (`GOOGLE_GENAI_USE_VERTEXAI=TRUE`)
- A Gemini 3+ model that supports `stream_function_call_arguments`

Without these requirements, the middleware falls back to accumulated-args mode. With `PROGRESSIVE_SSE_STREAMING` (ADK >= 1.20.0), this still emits multiple `TOOL_CALL_ARGS` events — but each contains the full accumulated JSON so far rather than an incremental chunk, so the frontend sees the value replaced repeatedly rather than appended to. On older ADK versions, a single `TOOL_CALL_ARGS` event is emitted with the complete arguments after the model finishes generating them.

See `examples/server/api/predictive_state_updates.py` for a complete working example with auto-detection and fallback.

## Event Translation

The middleware translates between AG-UI and ADK event formats:

| AG-UI Event | ADK Event | Description |
|-------------|-----------|-------------|
| TEXT_MESSAGE_* | Event with content.parts[].text | Text messages |
| RUN_STARTED/FINISHED | Runner lifecycle | Execution flow |

## Message History Features

### MESSAGES_SNAPSHOT Emission

You can configure the middleware to emit a `MESSAGES_SNAPSHOT` event at the end of each run, containing the full conversation history:

```python
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123",
    emit_messages_snapshot=True  # Emit full message history at run end
)
```

When enabled, the middleware will:
1. Extract all events from the ADK session at the end of each run
2. Convert them to AG-UI message format
3. Emit a `MESSAGES_SNAPSHOT` event with the complete conversation history

This is useful for clients that need to persist conversation history or for AG-UI protocol compliance.

### Converting ADK Events to Messages

The `adk_events_to_messages()` function is available for direct use if you need to convert ADK session events to AG-UI messages:

```python
from ag_ui_adk import adk_events_to_messages

# Get events from an ADK session
session = await session_service.get_session(session_id, app_name, user_id)
messages = adk_events_to_messages(session.events)

# messages is a list of AG-UI Message objects (UserMessage, AssistantMessage, ToolMessage)
```

### Experimental: /agents/state Endpoint

**WARNING: This endpoint is experimental and subject to change in future versions.**

When using `add_adk_fastapi_endpoint()`, an additional `POST /agents/state` endpoint is automatically added. This endpoint allows front-end frameworks to retrieve thread state and message history on-demand, without initiating a new agent run.

**Request:**
```json
{
  "threadId": "thread_123",
  "appName": "my_app",
  "userId": "user_123",
  "name": "optional_agent_name",
  "properties": {}
}
```

The `appName` and `userId` parameters are optional if the `ADKAgent` was configured with static values. They are required for session lookup when using dynamic extractors or after middleware restart.

**Response:**
```json
{
  "threadId": "thread_123",
  "threadExists": true,
  "state": "{\"key\": \"value\"}",
  "messages": "[{\"id\": \"1\", \"role\": \"user\", \"content\": \"Hello\"}]"
}
```

Note: The `state` and `messages` fields are JSON-stringified for compatibility with front-end frameworks that expect this format.

**Example usage:**
```python
import httpx

async def get_thread_history(thread_id: str, app_name: str, user_id: str):
    async with httpx.AsyncClient() as client:
        response = await client.post(
            "http://localhost:8000/agents/state",
            json={
                "threadId": thread_id,
                "appName": app_name,
                "userId": user_id
            }
        )
        data = response.json()
        if data["threadExists"]:
            import json
            messages = json.loads(data["messages"])
            state = json.loads(data["state"])
            return messages, state
        return [], {}
```

## Additional Resources

- For configuration options, see [CONFIGURATION.md](./CONFIGURATION.md)
- For architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md)
- For development setup, see the main [README.md](./README.md)
- For API documentation, refer to the source code docstrings