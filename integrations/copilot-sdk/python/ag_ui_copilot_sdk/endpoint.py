from typing import Any

from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import StreamingResponse

from .agent import CopilotAgent


def add_copilot_fastapi_endpoint(
    app: FastAPI | APIRouter,
    agent: CopilotAgent,
    path: str = "/",
    **kwargs: Any,
):
    """Adds a GitHub Copilot SDK endpoint to the FastAPI app.

    Args:
        app: FastAPI application or APIRouter to register the routes on.
        agent: Copilot SDK agent to serve.
        path: Path of the agent route.
        **kwargs: Forwarded to ``app.post`` for the agent route (``name``,
            ``tags``, ``operation_id``, ``dependencies``, ``include_in_schema``,
            ...). They do not apply to the other routes this helper registers,
            because values such as ``operation_id`` and ``name`` must stay
            unique per operation.
    """

    @app.post(path, **kwargs)
    async def copilot_agent_endpoint(input_data: RunAgentInput, request: Request):
        encoder = EventEncoder(accept=request.headers.get("accept"))

        async def event_generator():
            async for event in agent.run(input_data):
                yield encoder.encode(event)

        return StreamingResponse(event_generator(), media_type=encoder.get_content_type())

    @app.get(f"{path}/health")
    def health():
        """Health check."""
        return {"status": "ok", "agent": {"name": agent.name}}
