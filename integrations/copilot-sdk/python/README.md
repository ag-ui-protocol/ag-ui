# ag-ui-copilot-sdk

Implementation of the AG-UI protocol for the native GitHub Copilot SDK (Python).

## Installation

```bash
uv sync --extra server
```

## Usage

The agent owns the native SDK session lifecycle — just call `agent.run(input_data)`:

```python
from copilot import CopilotClient
from ag_ui_copilot_sdk import CopilotAgent, add_copilot_fastapi_endpoint

client = CopilotClient(mode="empty", base_directory=runtime_dir)
await client.start()

agent = CopilotAgent(client, name="agentic_chat", model="gpt-5.4-mini")
add_copilot_fastapi_endpoint(app=app, agent=agent, path="/agentic_chat")
```

`add_copilot_fastapi_endpoint` registers the agent route plus a `/health` route,
and forwards extra keyword arguments to `app.post`.

## Features

- **One native session per thread** — reused across runs, so the model keeps its turn context
- **Frontend tool handoff** — suspended tool calls are resolved through the original pending RPC, not replayed as text (see the [integration README](../README.md))
- **Tool errors** — a `role: "tool"` message carrying `error` is forwarded to the model as a failure result
- **Context injection** — `RunAgentInput.context` and `state` are injected into the prompt preamble
- **BYOK provider** — set `OPENAI_BASE_URL` / `OPENAI_API_KEY` to use any OpenAI-compatible endpoint

## Examples

| Route | Description |
|-------|-------------|
| `/agentic_chat` | Basic conversational assistant |

```bash
cd integrations/copilot-sdk/python
uv run --extra server python examples/server.py   # port 8027
```

The example server binds to loopback and is unauthenticated — it is a demo, not
a deployment template.

## Tests

```bash
uv run pytest
uv run ruff check .
```

The tests drive the agent with a scripted fake client: no native runtime, no
model, no network.
