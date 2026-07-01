from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder

from .adapter import ClaudeAgentAdapter


def add_claude_fastapi_endpoint(app: FastAPI, adapter: ClaudeAgentAdapter, path: str = "/"):
    """Adds a Claude Agent SDK endpoint to the FastAPI app."""

    @app.post(path)
    async def claude_agent_endpoint(input_data: RunAgentInput, request: Request):
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        async def event_generator():
            async for event in adapter.run(input_data):
                yield encoder.encode(event)

        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type()
        )

    @app.get(f"{path}/health")
    def health():
        """Health check."""
        return {
            "status": "ok",
            "agent": {
                "name": adapter.name,
            }
        }
