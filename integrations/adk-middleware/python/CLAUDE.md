# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

**Important**: Use `.venv/bin/pytest` to run tests with the project's virtual environment.

```bash
# Install in editable mode for development
pip install -e .

# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
.venv/bin/pytest

# Run tests with coverage
.venv/bin/pytest --cov=src/ag_ui_adk

# Run a specific test file
.venv/bin/pytest tests/test_adk_agent.py

# Run a specific test
.venv/bin/pytest tests/test_adk_agent.py::test_function_name

# Code formatting
black src tests
isort src tests

# Linting
flake8 src tests

# Type checking
mypy src
```

### Running Examples

```bash
cd examples
uv sync
uv run dev

# Or directly with uvicorn
uvicorn server:app --host 0.0.0.0 --port 8000
```

Requires `GOOGLE_API_KEY` environment variable for Gemini models.

## High-Level Architecture

This package (`ag_ui_adk`) is a middleware that bridges [Google ADK](https://google.github.io/adk-docs/) agents with the [AG-UI Protocol](https://github.com/ag-ui-protocol/ag-ui). It translates between the two frameworks' event systems.

### Core Components (in `src/ag_ui_adk/`)

```
AG-UI Protocol          ADK Middleware           Google ADK
     │                        │                       │
RunAgentInput ──────> ADKAgent.run() ──────> Runner.run_async()
     │                        │                       │
     │                 EventTranslator                │
     │                        │                       │
BaseEvent[] <──────── translate events <──────── Event[]
```

- **`adk_agent.py`** - Main orchestrator `ADKAgent` class that wraps ADK agents for AG-UI compatibility. Manages lifecycle, sessions, and tool coordination.

- **`event_translator.py`** - Converts ADK events to AG-UI protocol events (16 standard event types). Handles streaming text, message boundaries, and per-session isolation.

- **`session_manager.py`** - Singleton managing session lifecycle, cleanup with configurable timeouts, memory service integration, and resource limits.

- **`execution_state.py`** - Tracks background ADK executions, manages asyncio tasks, event queues for streaming, and tool call state.

- **`client_proxy_tool.py`** / **`client_proxy_toolset.py`** - Wraps AG-UI tools for ADK compatibility. All client tools are long-running (fire-and-forget for HITL workflows).

- **`endpoint.py`** - FastAPI integration via `add_adk_fastapi_endpoint()` and `create_adk_app()`.

- **`config.py`** - Configuration classes including `PredictStateMapping` for predictive state updates.

### Key Integration Pattern

```python
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from google.adk.agents import Agent

# 1. Create ADK agent
my_agent = Agent(name="assistant", instruction="...")

# 2. Wrap with middleware
agent = ADKAgent(adk_agent=my_agent, app_name="my_app", user_id="user123")

# 3. Use directly or add FastAPI endpoint
async for event in agent.run(input_data):
    print(event.type)

# Or with FastAPI
app = FastAPI()
add_adk_fastapi_endpoint(app, agent, path="/chat")
```

### Tool Execution Flow

All client-supplied tools are long-running, ideal for human-in-the-loop workflows:

1. Initial AG-UI Run → ADK Agent starts execution
2. ADK Agent requests tool use → Execution pauses
3. Tool events emitted (TOOL_CALL_START/ARGS/END) → Client receives tool call info
4. Client executes tools → Results prepared asynchronously
5. Subsequent AG-UI Run with ToolMessage → ADK execution resumes
6. Final response → Execution completes

### Environment Variables for Logging

```bash
LOG_ROOT_LEVEL=INFO       # Root logger level
LOG_ADK_AGENT=DEBUG       # adk_agent component
LOG_EVENT_TRANSLATOR=INFO # event_translator component
LOG_ENDPOINT=ERROR        # endpoint component
LOG_SESSION_MANAGER=WARNING # session_manager component
```

## Testing

The test suite has 270+ tests covering:
- Unit tests for each component
- Integration tests for end-to-end flows
- HITL (human-in-the-loop) tool tracking
- Multi-turn conversation handling
- Session management and cleanup
- Concurrent execution limits
- Predictive state updates

Tests use pytest-asyncio for async test support.
