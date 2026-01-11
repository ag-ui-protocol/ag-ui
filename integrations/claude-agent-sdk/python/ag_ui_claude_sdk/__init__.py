"""
AG-UI integration for Anthropic Claude Agent SDK.

This package provides an AG-UI compatible adapter for the Claude Agent SDK,
enabling Claude-powered agents to communicate with AG-UI compatible frontends.

Example:
    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse
    from ag_ui.core import RunAgentInput
    from ag_ui.encoder import EventEncoder
    from ag_ui_claude_sdk import ClaudeAgentAdapter
    
    app = FastAPI()
    adapter = ClaudeAgentAdapter(
        model="claude-sonnet-4-20250514",
        permission_mode="acceptEdits",
    )
    
    @app.post("/")
    async def run(input_data: RunAgentInput, request: Request):
        encoder = EventEncoder(accept=request.headers.get("accept"))
        async def stream():
            async for event in adapter.run(input_data):
                yield encoder.encode(event)
        return StreamingResponse(stream(), media_type=encoder.get_content_type())

For full documentation on ClaudeAgentOptions, see:
https://platform.claude.com/docs/en/agent-sdk/python
"""

from .adapter import ClaudeAgentAdapter
from .types import MessageHistory, ActivityState, ActivityStatus

__version__ = "0.1.0"
__all__ = [
    "ClaudeAgentAdapter",
    "MessageHistory",
    "ActivityState",
    "ActivityStatus",
]

