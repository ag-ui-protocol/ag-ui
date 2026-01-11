# ag-ui-claude-agent-sdk

Implementation of the AG-UI protocol for the Anthropic Claude Agent SDK.

Provides a complete Python integration for Claude agents with the AG-UI protocol, including FastAPI endpoint creation and comprehensive event streaming.

## Installation

```bash
pip install -e .
```

## Usage

```python
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from ag_ui_claude_sdk import ClaudeAgentAdapter

app = FastAPI()
adapter = ClaudeAgentAdapter(
    model="claude-haiku-4-5",
)

@app.post("/")
async def run(input_data: RunAgentInput, request: Request):
    encoder = EventEncoder(accept=request.headers.get("accept"))
    async def stream():
        async for event in adapter.run(input_data):
            yield encoder.encode(event)
    return StreamingResponse(stream(), media_type=encoder.get_content_type())
```

## Features

- **Native Claude SDK integration** – Direct support for Claude Agent SDK with streaming responses
- **FastAPI endpoint creation** – Automatic HTTP endpoint generation with proper event streaming
- **Advanced event handling** – Comprehensive support for all AG-UI events including thinking, tool calls, and state updates
- **Custom tools via MCP** – Define custom tools using Claude SDK's @tool decorator
- **Multi-user support** – Thread-based conversation separation via session_id

## To run the dojo examples

```bash
# Install dependencies
cd python
pip install -e .

# Start server
cd examples
ANTHROPIC_API_KEY=sk-ant-xxx python server.py
```

Server runs on **http://localhost:8888**

## Links

- [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools)
- [AG-UI Documentation](https://docs.ag-ui.com/)
