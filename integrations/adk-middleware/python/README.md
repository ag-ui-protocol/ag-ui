# ADK Middleware for AG-UI Protocol

This Python middleware enables [Google ADK](https://google.github.io/adk-docs/) agents to be used with the AG-UI Protocol, providing a bridge between the two frameworks.

## Prerequisites

The middleware supports CPython 3.10–3.15 (`>=3.10,<3.16`). Python 3.15
requires `ag-ui-a2ui-toolkit>=0.0.5`, which is included in the package's
dependencies. The locked environment uses Google ADK 1.35.0; the supported
dependency range remains `google-adk>=1.28.1,<3.0.0`.

A2UI uses `a2ui-agent-sdk>=0.9.0,<0.10.0` and `a2ui-core>=0.4.0,<0.5.0`
([#3121](https://github.com/ag-ui-protocol/ag-ui/issues/3121)). The helper now
uses the published `Catalog` and Direct JSON processor/prompt APIs, so the
adapter can share an environment with SDK 0.9's Express and Direct JSON
consumers. Legacy SDK 0.2.x is no longer supported: its removed `a2ui.schema`
API and bundled framework integrations require a different implementation.
This migration supersedes the 0.2.2 pin from #3089 rather than reverting it.

Catalog prompts preserve client components, definitions and instructions,
and include the relevant protocol/common types. Rendering follows a catalog's
`protocolVersion` (`0.8` or `0.9`, default `0.9`); the `generate_a2ui` tool
continues to emit v0.9 operations. Only catalog instructions are reused, without
the SDK's text-tag delivery rules or strict payload validation. Validation
remains with `ag-ui-a2ui-toolkit` so client catalogs with unresolved refs still
work. JSON repair still uses `parse_and_fix`. Unusable catalogs retain the raw
prompt fallback; SDK rendering failures log a warning before that fallback.

AG-UI needs neither the separate `a2ui-adk` integration nor `a2ui-a2a` and adds
no A2A version constraint. Applications that use Google's `a2ui.adk` tools
directly must separately install `a2ui-adk` and follow its requirements.
The migrated SDK-backed A2UI tests and clean wheel installation were verified
on CPython 3.13.13 with SDK 0.9.0, core 0.4.0, Google ADK 2.12.0 and Google
GenAI 2.31.0. This does not change the existing ADK 2.x full-suite limitations
described below.

CI runs the full suite on Python 3.12 and 3.15. The 3.15 job also builds the
sdist and wheel, installs the wheel with pip in a clean environment, and runs
the suite outside the source checkout. Google ADK 2.x has a separate
informational full-suite job with known failures; Python 3.15 support does
not resolve those existing compatibility limitations. Free-threaded Python
and Windows have not been verified.

The examples use ADK Agents using various Gemini models along with the AG-UI Dojo.
The separate `examples/` application currently requires Python 3.10–3.14;
its environment has not yet been updated for Python 3.15.

- A [Gemini API Key](https://makersuite.google.com/app/apikey). The examples assume that this is exported via the GOOGLE_API_KEY environment variable.

## Quick Start

To use this integration you need to:

1. Clone the [AG-UI repository](https://github.com/ag-ui-protocol/ag-ui).

    ```bash
    git clone https://github.com/ag-ui-protocol/ag-ui.git
    ```

2. Change to the `integrations/adk-middleware/python` directory.

    ```bash
    cd integrations/adk-middleware/python
    ```

3. Install the `adk-middleware` package from the local directory.  For example,

    ```bash
    pip install .
    ```

    or

    ```bash
    uv pip install .
    ```

    This installs the package from the current directory which contains:
    - `src/ag_ui_adk/` - The middleware source code
    - `examples/` - Example servers and agents
    - `tests/` - Test suite

4. Install the requirements for the `examples`, for example:

    ```bash
    uv pip install -r requirements.txt
    ```

5. Run the example fast_api server.

    ```bash
    export GOOGLE_API_KEY=<My API Key>
    cd examples
    uv sync
    uv run dev
    ```

6. Open another terminal in the root directory of the ag-ui repository clone.

7. Start the integration ag-ui dojo:

    ```bash
    pnpm install && pnpm run dev
    ```

8. Visit [http://localhost:3000/adk-middleware](http://localhost:3000/adk-middleware).

9. Select View `ADK Middleware` from the sidebar.

### Development Setup

If you want to contribute to ADK Middleware development, you'll need to take some additional steps.  You can either use the following script of the manual development setup.

```bash
# From the adk-middleware directory
chmod +x setup_dev.sh
./setup_dev.sh
```

### Manual Development Setup

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

## Testing

```bash
# Run tests (271 comprehensive tests)
pytest

# With coverage
pytest --cov=src/ag_ui_adk

# Specific test file
pytest tests/test_adk_agent.py
```
## Usage options

### Option 1: Direct Usage
```python
from ag_ui_adk import ADKAgent
from google.adk.agents import Agent

# 1. Create your ADK agent
my_agent = Agent(
    name="assistant",
    instruction="You are a helpful assistant."
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
    ]
)

# 2. Create the middleware with direct agent embedding
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123"
)

# 3. Use directly with AG-UI RunAgentInput
async for event in agent.run(input_data):
    print(f"Event: {event.type}")
```

### Option 2: FastAPI Server

```python
from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from google.adk.agents import Agent

# 1. Create your ADK agent
my_agent = Agent(
    name="assistant",
    instruction="You are a helpful assistant."
    tools=[
        AGUIToolset(), # Add the tools provided by the AG-UI client
    ]
)

# 2. Create the middleware with direct agent embedding
agent = ADKAgent(
    adk_agent=my_agent,
    app_name="my_app",
    user_id="user123"
)

# 3. Create FastAPI app
app = FastAPI()
add_adk_fastapi_endpoint(
    app, agent, path="/chat",
    extract_headers=["x-user-id", "x-tenant-id"]  # Extract HTTP headers into state.headers
)

# Run with: uvicorn your_module:app --host 0.0.0.0 --port 8000
```

For detailed configuration options, see [CONFIGURATION.md](./CONFIGURATION.md)

### Option 3: Using ADK App with ResumabilityConfig (HITL)

> **Requires `google-adk >= 1.16.0`**

For human-in-the-loop (HITL) workflows where the agent pauses for user approval and resumes afterward, use `ADKAgent.from_app()` with ADK's `ResumabilityConfig`. This enables ADK to persist `FunctionCall` events before pausing, allowing seamless resumption when the user provides tool results.

```python
from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint, AGUIToolset
from google.adk.agents import Agent
from google.adk.apps import App, ResumabilityConfig

# 1. Create your ADK agent with client-side tools
my_agent = Agent(
    name="assistant",
    instruction="You are a helpful assistant.",
    tools=[
        AGUIToolset(),  # Client-side tools for HITL workflows
    ]
)

# 2. Wrap in an ADK App with ResumabilityConfig
adk_app = App(
    name="my_app",
    root_agent=my_agent,
    resumability_config=ResumabilityConfig(is_resumable=True),
)

# 3. Create the middleware using from_app()
agent = ADKAgent.from_app(
    adk_app,
    user_id="user123",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

# 4. Add FastAPI endpoint
app = FastAPI()
add_adk_fastapi_endpoint(app, agent, path="/chat")
```

**How it works:**

1. The agent calls a client-side tool (e.g., `generate_task_steps`) — ADK persists the `FunctionCall` event and pauses execution
2. The middleware emits `TOOL_CALL_START`, `TOOL_CALL_ARGS`, and `TOOL_CALL_END` events to the frontend
3. The user reviews and responds (approve/reject), and the frontend sends a `ToolMessage` with the result, or a `resume` entry (see [TOOLS.md](./TOOLS.md#interrupts-and-resume))
4. The middleware resumes ADK execution with the stored `invocation_id`, restoring the agent's position
5. The agent continues from where it left off with the user's response

With `emit_interrupt_outcome=True` (default `False`), a tool confirmation (`tool_context.request_confirmation()`) additionally ends its run with an interrupt outcome on `RUN_FINISHED`. Enable it only with a frontend that resumes via `RunAgentInput.resume`; see [TOOLS.md](./TOOLS.md#interrupts-and-resume).

**When to use `from_app()` vs direct `ADKAgent()`:**

| Feature | `ADKAgent(adk_agent=...)` | `ADKAgent.from_app(app)` |
|---|---|---|
| Basic HITL | ~~Yes (fire-and-forget)~~ **Deprecated** | Yes (native resumability) |
| Session persistence across pause/resume | Manual | Automatic |
| SequentialAgent sub-agent position restore | No | Yes |
| Requires `google-adk` | Any version | >= 1.16.0 |

> **Deprecation notice:** The fire-and-forget HITL flow via `ADKAgent(adk_agent=...)` is deprecated and will be removed in a future version. For human-in-the-loop workflows, use `ADKAgent.from_app()` with `ResumabilityConfig(is_resumable=True)`. The direct constructor remains fully supported for agents without client-side tools. See [USAGE.md](./USAGE.md#migrating-to-resumable-hitl) for migration instructions.

See `examples/server/api/human_in_the_loop.py` for a complete working example.

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
from ag_ui_adk import ADKAgent
from google.adk.agents import Agent
from ag_ui.core import RunAgentInput, UserMessage

async def main():
    # Setup
    my_agent = Agent(
        name="assistant", 
        instruction="You are a helpful assistant.", 
        tools=[
            AGUIToolset(), # Add the tools provided by the AG-UI client
        ]
    )

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

### Multiple AG-UI Endpoints

```python
# Create multiple ADKAgent instances with different ADK agents
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

## Context Support

The middleware automatically passes `context` from `RunAgentInput` to your ADK agents, following the pattern established by LangGraph. Context is stored in session state under the `_ag_ui_context` key and is accessible in both tools and instruction providers.

### In Tools via Session State

```python
from google.adk.tools import ToolContext
from ag_ui_adk import CONTEXT_STATE_KEY

def my_tool(tool_context: ToolContext) -> str:
    context_items = tool_context.state.get(CONTEXT_STATE_KEY, [])
    for item in context_items:
        print(f"{item['description']}: {item['value']}")
    return "Done"
```

### In Instruction Providers via Session State

```python
from google.adk.agents.readonly_context import ReadonlyContext
from ag_ui_adk import CONTEXT_STATE_KEY

def dynamic_instructions(ctx: ReadonlyContext) -> str:
    instructions = "You are a helpful assistant."

    context_items = ctx.state.get(CONTEXT_STATE_KEY, [])
    for item in context_items:
        instructions += f"\n- {item['description']}: {item['value']}"

    return instructions

agent = LlmAgent(
    name="assistant",
    instruction=dynamic_instructions,  # Callable instruction provider
)
```

### Alternative: Via RunConfig custom_metadata

Context is also available via `RunConfig.custom_metadata`:

```python
def dynamic_instructions(ctx: ReadonlyContext) -> str:
    # Alternative access via custom_metadata
    if ctx.run_config and ctx.run_config.custom_metadata:
        context_items = ctx.run_config.custom_metadata.get('ag_ui_context', [])
```

**Note:** Session state is the recommended approach as it works with all ADK versions.

See `examples/other/context_usage.py` for a complete demonstration.

## Tool Support

The middleware provides complete bidirectional tool support, enabling AG-UI Protocol tools to execute within Google ADK agents. All tools supplied by the client are currently implemented as long-running tools that emit events to the client for execution and can be combined with backend tools provided by the agent to create a hybrid combined toolset.

### Adk Agent Agui Tool Support

Use the AGUIToolset to expose tools from the AG-UI client to the ADK agent. By default all agui client tools are added to the context. You can filter which tools to expose using the `tool_filter` parameter and fix name conflicts with the `tool_name_prefix` parameter. In google adk tools with the same name override previously defined tools of the same name. You can order the tools array to control which tool takes precedence.

```python
from ag_ui_adk import ADKAgent, AGUIToolset
from google.adk.agents import Agent

hello_agent = LlmAgent(
    name='HelloAgent',
    model='gemini-3.5-flash',
    description="An agent that greets users",
    instruction="""
    You are a friendly assistant that greets users.
    Use the sayHello tool to greet the user.
    """,
    tools=[
        AGUIToolset(tool_filter=['sayHello']) # Add only the sayHello tool exposed by the AG-UI client
    ],
)

goodbye_agent = LlmAgent(
    name='GoodbyeAgent',
    model='gemini-3.5-flash',
    description="An agent that says goodbye",
    instruction="""
    You are a friendly assistant that says goodbye to users.
    Use the sayGoodbye tool to say goodbye to the user.
    """,
        tools=[
        AGUIToolset(tool_filter=lambda tool, readonly_context=None: tool.name.endswith('Goodbye') ) # Add tools ending with Goodbye exposed by the AG-UI client
    ],
)

# create an agent
agent = LlmAgent(
    name='QaAgent',
    model='gemini-3.5-flash',
    description="The QaAgent helps users by answering their questions.",
    instruction="""
    You are a helpful assistant. Help users by answering their questions and assisting with their needs.
    """,
    tools=[
        # This agent doesn't see any tools provided by the AG-UI client
    ],
    sub_agents=[
        hello_agent, 
        goodbye_agent,
    ],
)
```


For detailed information about tool support, see [TOOLS.md](./TOOLS.md).

## Additional Documentation

- **[CONFIGURATION.md](./CONFIGURATION.md)** - Complete configuration guide
- **[TOOLS.md](./TOOLS.md)** - Tool support documentation
- **[USAGE.md](./USAGE.md)** - Usage examples and patterns
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Technical architecture and design details

## Migration Guide

### Migrating from v0.4.x 

If you are upgrading from version 0.4.x, please note the following changes:

- Agui tools are no longer automatically included in the root agent's toolset. You must explicitly add the `AGUIToolset` to your agent's tools list to access AG-UI client tools.

- Agui tools with names that conflict with existing agent tools will no longer be automatically removed. Use the `tool_name_prefix` and `tool_filter` parameters of `AGUIToolset` to manage tool name conflicts and filter which tools to include.

- If you want to maintain the previous behavior of only the root agent having access to AG-UI tools, and ensure no name conflicts, you can add the `AGUIToolset` with a custom filter as the first tool in the root agent like this:

    ```python
    tools=[
        AGUIToolset(
            tool_filter=lambda tool, readonly_context=None: tool.name not in [
                "transfer_to_agent", 
                "any other tools provided to this agent that overlap with agui tools...",
            ],
        ),
        ...other tools...
    ]
    ```
