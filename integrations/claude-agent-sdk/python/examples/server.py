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

# Simple shared working directory (agents don't have file tools enabled)
WORK_DIR = Path(tempfile.gettempdir()) / "claude-sdk-server"
WORK_DIR.mkdir(parents=True, exist_ok=True)

# Create adapters once at module level
agentic_chat_adapter = create_agentic_chat_adapter(str(WORK_DIR))
backend_tool_adapter = create_backend_tool_adapter(str(WORK_DIR))

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
    return await run_adapter(agentic_chat_adapter, input_data, request)


@app.post("/backend_tool_rendering")
async def backend_tool_rendering_endpoint(input_data: RunAgentInput, request: Request):
    return await run_adapter(backend_tool_adapter, input_data, request)


@app.get("/health")
async def health():
    return {"status": "healthy"}


def main():
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("Error: ANTHROPIC_API_KEY required")
        return 1
    
    port = int(os.getenv("PORT", "8888"))
    print(f"Starting server on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    exit(main())
