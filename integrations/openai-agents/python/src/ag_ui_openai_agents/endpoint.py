"""FastAPI endpoint helper for serving an OpenAI Agents SDK agent over AG-UI."""

import logging
import re
from typing import AsyncIterator

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
    *,
    include_health: bool = True,
) -> None:
    """Add an OpenAI Agents SDK agent endpoint to a FastAPI app.

    Args:
        app: The FastAPI application to register the route on.
        agent: The wrapped agent to serve.
        path: The POST path for the agent. Defaults to "/".
        include_health: Whether to register a GET health check alongside the
            agent endpoint. Defaults to True.
    """
    # Unique per-route names/operation_ids so mounting several agents on one app
    # does not collide (FastAPI derives both from the handler __name__ otherwise,
    # producing duplicate operation ids and an ambiguous OpenAPI schema).
    slug = re.sub(r"\W+", "_", path).strip("_") or "root"

    @app.post(path, name=f"openai_agents_run_{slug}", operation_id=f"openai_agents_run_{slug}")
    async def openai_agents_endpoint(
        input_data: RunAgentInput,
        request: Request,
    ) -> StreamingResponse:
        """Run the agent and stream AG-UI events back to the client."""
        logger.info(
            "Starting agent run: agent=%s thread_id=%s run_id=%s",
            agent.name,
            input_data.thread_id,
            input_data.run_id,
        )
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        async def event_generator() -> AsyncIterator[str]:
            try:
                async for event in agent.run_streamed(input_data):
                    yield encoder.encode(event)
            except Exception:
                # to_agui already emitted RUN_ERROR before re-raising (see
                # AGUITranslator.to_agui). Swallow-and-log here so the client
                # gets its clean terminal event without an ASGI-level unhandled
                # exception traceback and an abruptly severed stream.
                logger.exception(
                    "Agent run failed: agent=%s run_id=%s",
                    agent.name,
                    input_data.run_id,
                )

        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type(),
        )

    if include_health:

        @app.get(
            path.rstrip("/") + "/health",
            name=f"openai_agents_health_{slug}",
            operation_id=f"openai_agents_health_{slug}",
        )
        def health():
            """Health check."""
            return {"status": "ok", "agent": {"name": agent.name}}
