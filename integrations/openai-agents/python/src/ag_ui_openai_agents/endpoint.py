"""FastAPI endpoint helper for the OpenAI Agents SDK integration.

Glue an OpenAIAgentsAgent to a FastAPI app in one call: SSE stream, content
negotiation, health check.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder

from .agent import OpenAIAgentsAgent

logger = logging.getLogger(__name__)


def add_openai_agents_fastapi_endpoint(
    app: FastAPI,
    agent: OpenAIAgentsAgent,
    path: str = "/",
) -> None:
    """Add an OpenAI Agents SDK agent endpoint to a FastAPI app.

    Args:
        app: The FastAPI application to register the route on.
        agent: The wrapped agent to serve.
        path: The POST path for the agent. Defaults to "/". A GET health check
            is registered alongside it.
    """

    @app.post(path)
    async def openai_agents_endpoint(input_data: RunAgentInput, request: Request):
        """Run the agent and stream AG-UI events back to the client."""
        logger.info(
            "Starting agent run: agent=%s thread_id=%s run_id=%s",
            agent.name,
            input_data.thread_id,
            input_data.run_id,
        )
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        async def event_generator():
            async for event in agent.run(input_data):
                yield encoder.encode(event)

        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type(),
        )

    @app.get(path.rstrip("/") + "/health")
    def health():
        """Health check."""
        return {"status": "ok", "agent": {"name": agent.name}}
