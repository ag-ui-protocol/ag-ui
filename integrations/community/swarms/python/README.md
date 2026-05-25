# AG-UI × Swarms

Expose any [Swarms](https://github.com/kyegomez/swarms) agent as an
[AG-UI](https://github.com/ag-ui-protocol/ag-ui)-compatible SSE endpoint with a
single function call.

## Installation

```bash
pip install ag-ui-swarms
```

## Quick start

```python
from fastapi import FastAPI
from swarms import Agent
from swarms_agui import add_swarms_fastapi_endpoint

agent = Agent(
    agent_name="Assistant",
    system_prompt="You are a helpful assistant.",
    model_name="gpt-4o",
)

app = FastAPI()
add_swarms_fastapi_endpoint(app, agent, path="/")
```

Run it:

```bash
uvicorn main:app --reload
```

Your agent is now available at `POST /` and streams AG-UI SSE events that any
AG-UI-compatible frontend can consume.

## How it works

`add_swarms_fastapi_endpoint` registers a POST route on your FastAPI app.
On each request it:

1. Emits `RUN_STARTED`
2. Emits `TEXT_MESSAGE_START`
3. Calls `agent.run(task)` where `task` is the last user message
4. Emits `TEXT_MESSAGE_CONTENT` with the full response
5. Emits `TEXT_MESSAGE_END`
6. Emits `MESSAGES_SNAPSHOT` with the updated message list
7. Emits `RUN_FINISHED`

If `agent.run` raises, a `RUN_ERROR` event is emitted instead.

## Running the tests

```bash
pip install -e ".[dev]"
pytest tests/
```
