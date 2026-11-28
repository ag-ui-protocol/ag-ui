from collections.abc import Awaitable, Callable
from inspect import isawaitable
from typing import Any

from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import StreamingResponse

from .agent import LangGraphAgent
from .run_guidance import RunGuidanceAgentMixin


def add_langgraph_fastapi_endpoint(
    app: FastAPI | APIRouter,
    agent: LangGraphAgent,
    path: str = "/",
    *,
    authorize_guidance: Callable[[Request], bool | Awaitable[bool]] | None = None,
    trusted_ingress: bool = False,
    **kwargs: Any,
):
    """Adds an endpoint to the FastAPI app.

    Args:
        app: FastAPI application or APIRouter to register the routes on.
        agent: LangGraph agent to serve.
        path: Path of the agent route.
        authorize_guidance: Host authorization for agent POST requests and
            the capabilities route when present. Return True to authorize system
            guidance, False for anonymous handling, or raise an HTTPException
            to reject the request. Takes precedence over trusted_ingress. With
            guidance disabled, either boolean allows legacy prompt handling.
        trusted_ingress: Set only when deployment access controls restrict this
            endpoint to authorized callers.
        **kwargs: Forwarded to ``app.post`` for the agent route (``name``,
            ``tags``, ``operation_id``, ``dependencies``, ``include_in_schema``,
            ...). They do not apply to the other routes this helper registers,
            because values such as ``operation_id`` and ``name`` must stay
            unique per operation.
    """
    guidance_enabled = isinstance(agent, RunGuidanceAgentMixin)

    async def guidance_is_trusted(request: Request) -> bool:
        if authorize_guidance is None:
            return trusted_ingress is True
        authorized = authorize_guidance(request)
        if isawaitable(authorized):
            authorized = await authorized
        return authorized is True

    @app.post(path, **kwargs)
    async def langgraph_agent_endpoint(input_data: RunAgentInput, request: Request):
        # Create an event encoder to properly format SSE events.
        encoder = EventEncoder(accept=request.headers.get("accept"))

        trusted = (
            await guidance_is_trusted(request)
            if guidance_enabled or authorize_guidance is not None
            else False
        )

        # Each request gets isolated active_run state.
        request_agent = agent.clone()
        if isinstance(request_agent, RunGuidanceAgentMixin):
            events = request_agent.run(input_data, trusted_guidance=trusted)
        else:
            events = request_agent.run(input_data)

        async def event_generator():
            async for event in events:
                yield encoder.encode(event)

        return StreamingResponse(
            event_generator(), media_type=encoder.get_content_type()
        )

    @app.get(f"{path.rstrip('/')}/health")
    def health():
        """Health check."""
        return {
            "status": "ok",
            "agent": {
                "name": agent.name,
            },
        }

    if guidance_enabled:

        @app.get(f"{path.rstrip('/')}/capabilities")
        async def capabilities(request: Request):
            await guidance_is_trusted(request)
            return agent.get_capabilities()
