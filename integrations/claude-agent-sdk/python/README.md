# ag-ui-claude-agent-sdk

Implementation of the AG-UI protocol for the Anthropic Claude Agent SDK (Python).

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
    name="my_agent",
    description="A helpful AI assistant",
    options={
        "model": "claude-haiku-4-5",
    }
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

- **Native Claude SDK integration** - Direct support for Claude Agent SDK with streaming responses
- **Session management** - Automatic session tracking per thread with resumption support
- **Dynamic frontend tools** - Client-provided tools automatically added as MCP server with auto-granted permissions
- **Frontend tool halting** - Streams pause after frontend tool calls for client-side execution (human-in-the-loop)
- **Streaming tool arguments** - Real-time TOOL_CALL_ARGS emission as JSON arguments stream in
- **Bidirectional state sync** - Shared state management via ag_ui_update_state tool
- **Context injection** - Context and state injected into prompts for agent awareness
- **FastAPI endpoint creation** - Automatic HTTP endpoint generation with proper event streaming
- **Custom tools via MCP** - Define custom tools using Claude SDK's @tool decorator
- **Multi-user support** - Thread-based conversation separation with per-thread session persistence
- **Forwarded props** - Per-run option overrides with security whitelist

## Examples

The integration includes 5 example agents:

| Route | Description | Features |
|-------|-------------|----------|
| `/agentic_chat` | Basic conversational assistant | Simple chat |
| `/backend_tool_rendering` | Weather tool (backend MCP) | Backend tool execution, tool rendering |
| `/shared_state` | Recipe collaboration | Bidirectional state sync, ag_ui_update_state |
| `/human_in_the_loop` | Task planning with approval | Frontend tools, step tracking, approval workflow |
| `/tool_based_generative_ui` | Frontend tool rendering | Dynamic frontend tools, generative UI |

## Running the Examples

```bash
# Install dependencies
cd integrations/claude-agent-sdk/python
pip install -e .

# Start server (port 8888)
cd examples
ANTHROPIC_API_KEY=sk-ant-xxx python server.py

# Start Dojo (in another terminal)
cd apps/dojo
pnpm dev
```

Visit **http://localhost:3000** and select **"Claude Agent SDK (Python)"**

## Session Persistence

Claude SDK maintains conversation state in the `.claude/` directory. For production deployments:

- **Development**: Sessions persist locally in `.claude/{session_id}/`
- **Production**: Mount `.claude/` as a persistent volume in your container
- **Multi-process**: Use shared filesystem or network storage for `.claude/`

See [Claude SDK Hosting Guide](https://platform.claude.com/docs/en/agent-sdk/hosting) for deployment patterns.

## Links

- [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/python)
- [AG-UI Documentation](https://docs.ag-ui.com/)
- [AG-UI State Management](https://docs.ag-ui.com/concepts/state)
