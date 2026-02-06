"""
Multi-agent server for Claude Agent SDK integration.

This server exposes multiple agent endpoints for different AG-UI features,
matching the pattern used by LangGraph and other integrations.
"""

import os
import tempfile
from pathlib import Path
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from ag_ui.core import RunAgentInput, EventType, RunErrorEvent
from ag_ui.encoder import EventEncoder
from ag_ui_claude_sdk import ClaudeAgentAdapter

# Import agent configurations  
from agents.agentic_chat import create_agentic_chat_adapter
from agents.backend_tool_rendering import create_backend_tool_adapter
from agents.shared_state import create_shared_state_adapter
from agents.human_in_the_loop import create_human_in_the_loop_adapter
from agents.tool_based_generative_ui import create_tool_based_generative_ui_adapter

# Simple shared working directory (agents don't have file tools enabled)
WORK_DIR = Path(tempfile.gettempdir()) / "claude-sdk-server"
WORK_DIR.mkdir(parents=True, exist_ok=True)

# Create adapters once at module level
agentic_chat_adapter = create_agentic_chat_adapter(str(WORK_DIR))
backend_tool_adapter = create_backend_tool_adapter(str(WORK_DIR))
shared_state_adapter = create_shared_state_adapter(str(WORK_DIR))
human_in_the_loop_adapter = create_human_in_the_loop_adapter(str(WORK_DIR))
tool_based_generative_ui_adapter = create_tool_based_generative_ui_adapter(str(WORK_DIR))

app = FastAPI(title="Claude Agent SDK Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def run_adapter(adapter: ClaudeAgentAdapter, input_data: RunAgentInput, request: Request):
    encoder = EventEncoder(accept=request.headers.get("accept", "text/event-stream"))
    
    async def event_stream():
        try:
            async for event in adapter.run(input_data):
                yield encoder.encode(event)
        except Exception as e:
            error_event = RunErrorEvent(
                type=EventType.RUN_ERROR,
                thread_id=input_data.thread_id or "unknown",
                run_id=input_data.run_id or "unknown",
                message=str(e),
            )
            yield encoder.encode(error_event)
    
    return StreamingResponse(
        event_stream(),
        media_type=encoder.get_content_type(),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@app.post("/agentic_chat")
async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
    """Basic agentic chat with general purpose assistant."""
    return await run_adapter(agentic_chat_adapter, input_data, request)


@app.post("/backend_tool_rendering")
async def backend_tool_rendering_endpoint(input_data: RunAgentInput, request: Request):
    """Backend MCP tools that execute server-side (weather tool)."""
    return await run_adapter(backend_tool_adapter, input_data, request)


@app.post("/shared_state")
async def shared_state_endpoint(input_data: RunAgentInput, request: Request):
    """Collaborative recipe editing with bidirectional state sync."""
    return await run_adapter(shared_state_adapter, input_data, request)


@app.post("/human_in_the_loop")
async def human_in_the_loop_endpoint(input_data: RunAgentInput, request: Request):
    """Task planning with human approval workflow and step tracking."""
    return await run_adapter(human_in_the_loop_adapter, input_data, request)


@app.post("/tool_based_generative_ui")
async def tool_based_generative_ui_endpoint(input_data: RunAgentInput, request: Request):
    """Frontend tools for generative UI components (haiku rendering, etc)."""
    return await run_adapter(tool_based_generative_ui_adapter, input_data, request)


@app.get("/health")
async def health():
    return {"status": "healthy", "agents": 5}


def main():
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY required")
        return 1
    
    port = int(os.getenv("PORT", "8888"))
    print(f"Starting server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    exit(main())
