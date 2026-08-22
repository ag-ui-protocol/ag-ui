"""FastAPI endpoint utilities for AWS Strands integration."""

from typing import Any, Callable, Optional

from fastapi import Depends, FastAPI, Request
from fastapi.responses import StreamingResponse
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from .agent import StrandsAgent

def add_strands_fastapi_endpoint(
    app: FastAPI,
    agent: StrandsAgent,
    path: str,
    auth: Optional[Callable[..., Any]] = None,
    **kwargs
) -> None:
    """Add a Strands agent endpoint to FastAPI app.

    Args:
        app: FastAPI application instance
        agent: The StrandsAgent instance
        path: Path for the agent endpoint
        auth: Optional FastAPI dependency callable used to authenticate requests.
            It should raise ``fastapi.HTTPException`` to reject a request. The
            endpoint is unauthenticated when this is ``None``.
    """

    dependencies = [Depends(auth)] if auth is not None else []

    @app.post(path, dependencies=dependencies)
    async def strands_endpoint(input_data: RunAgentInput, request: Request):
        """AWS Strands agent endpoint."""
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)
        
        async def event_generator():
            async for event in agent.run(input_data):
                try:
                    yield encoder.encode(event)
                except Exception as e:
                    from ag_ui.core import RunErrorEvent, EventType
                    error_event = RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=f"Encoding error: {str(e)}",
                        code="ENCODING_ERROR"
                    )
                    yield encoder.encode(error_event)
                    break
        
        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type()
        )

def add_ping(app: FastAPI, path: str) -> None:
    """Add a ping endpoint to FastAPI app.
    
    Args:
        app: FastAPI application instance
        path: Path for the ping endpoint (default: "/ping")
    """
    
    @app.get(path)
    async def ping():
        """Ping endpoint."""
        return {"status": "healthy"}
