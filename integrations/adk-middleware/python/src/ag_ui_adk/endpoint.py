# src/endpoint.py

"""FastAPI endpoint for ADK middleware."""

from typing import List, Optional

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from .adk_agent import ADKAgent

import logging
logger = logging.getLogger(__name__)


def _header_to_key(header_name: str) -> str:
    """Convert header name to state key.

    Strips 'x-' prefix and converts hyphens to underscores.
    Example: 'x-user-id' -> 'user_id', 'x-tenant-id' -> 'tenant_id'
    """
    key = header_name.lower()
    if key.startswith("x-"):
        key = key[2:]
    return key.replace("-", "_")


def add_adk_fastapi_endpoint(
    app: FastAPI,
    agent: ADKAgent,
    path: str = "/",
    extract_headers: Optional[List[str]] = None,
):
    """Add ADK middleware endpoint to FastAPI app.

    Args:
        app: FastAPI application instance
        agent: Configured ADKAgent instance
        path: API endpoint path
        extract_headers: Optional list of HTTP header names to extract into state.
            Example: ["x-user-id", "x-tenant-id"]
            Headers are stored in state.headers with the 'x-' prefix stripped and
            hyphens converted to underscores (e.g., x-user-id -> user_id).
            Client-provided state.headers values take precedence over extracted headers.
    """

    @app.post(path)
    async def adk_endpoint(input_data: RunAgentInput, request: Request):
        """ADK middleware endpoint."""

        # Extract headers into state.headers if list provided
        if extract_headers:
            headers_dict = {}
            for header_name in extract_headers:
                value = request.headers.get(header_name)
                if value is not None:
                    state_key = _header_to_key(header_name)
                    headers_dict[state_key] = value

            if headers_dict:
                existing_state = input_data.state if isinstance(input_data.state, dict) else {}
                existing_headers = existing_state.get("headers", {}) if isinstance(existing_state.get("headers"), dict) else {}
                # Client headers take precedence over extracted headers
                merged_headers = {**headers_dict, **existing_headers}
                merged_state = {**existing_state, "headers": merged_headers}
                input_data = input_data.model_copy(update={"state": merged_state})

        # Get the accept header from the request
        accept_header = request.headers.get("accept")
        agent_id = path.lstrip('/')
        
        
        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)
        
        async def event_generator():
            """Generate events from ADK agent."""
            try:
                async for event in agent.run(input_data):
                    try:
                        encoded = encoder.encode(event)
                        logger.debug(f"HTTP Response: {encoded}")
                        yield encoded
                    except Exception as encoding_error:
                        # Handle encoding-specific errors
                        logger.error(f"❌ Event encoding error: {encoding_error}", exc_info=True)
                        # Create a RunErrorEvent for encoding failures
                        from ag_ui.core import RunErrorEvent, EventType
                        error_event = RunErrorEvent(
                            type=EventType.RUN_ERROR,
                            message=f"Event encoding failed: {str(encoding_error)}",
                            code="ENCODING_ERROR"
                        )
                        try:
                            error_encoded = encoder.encode(error_event)
                            yield error_encoded
                        except Exception:
                            # If we can't even encode the error event, yield a basic SSE error
                            logger.error("Failed to encode error event, yielding basic SSE error")
                            yield "event: error\ndata: {\"error\": \"Event encoding failed\"}\n\n"
                        break  # Stop the stream after an encoding error
            except Exception as agent_error:
                # Handle errors from ADKAgent.run() itself
                logger.error(f"❌ ADKAgent error: {agent_error}", exc_info=True)
                # ADKAgent should have yielded a RunErrorEvent, but if something went wrong
                # in the async generator itself, we need to handle it
                try:
                    from ag_ui.core import RunErrorEvent, EventType
                    error_event = RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=f"Agent execution failed: {str(agent_error)}",
                        code="AGENT_ERROR"
                    )
                    error_encoded = encoder.encode(error_event)
                    yield error_encoded
                except Exception:
                    # If we can't encode the error event, yield a basic SSE error
                    logger.error("Failed to encode agent error event, yielding basic SSE error")
                    yield "event: error\ndata: {\"error\": \"Agent execution failed\"}\n\n"
        
        return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


def create_adk_app(
    agent: ADKAgent,
    path: str = "/",
    extract_headers: Optional[List[str]] = None,
) -> FastAPI:
    """Create a FastAPI app with ADK middleware endpoint.

    Args:
        agent: Configured ADKAgent instance
        path: API endpoint path
        extract_headers: Optional list of HTTP header names to extract into state.
            Example: ["x-user-id", "x-tenant-id"]
            Headers are stored in state.headers with the 'x-' prefix stripped and
            hyphens converted to underscores (e.g., x-user-id -> user_id).
            Client-provided state.headers values take precedence over extracted headers.

    Returns:
        FastAPI application instance
    """
    app = FastAPI(title="ADK Middleware for AG-UI Protocol")
    add_adk_fastapi_endpoint(app, agent, path, extract_headers=extract_headers)
    return app