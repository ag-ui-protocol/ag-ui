# src/endpoint.py

"""FastAPI endpoint for ADK middleware."""

import json
import logging
import warnings
from typing import Any, Callable, Coroutine, List, Optional

from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .adk_agent import ADKAgent
from .event_translator import adk_events_to_messages

logger = logging.getLogger(__name__)


class AgentStateRequest(BaseModel):
    """Request body for /agents/state endpoint.

    EXPERIMENTAL: This endpoint is subject to change in future versions.
    """
    threadId: str
    appName: Optional[str] = None  # Required for session lookup; falls back to agent's static value
    userId: Optional[str] = None   # Required for session lookup; falls back to agent's static value
    name: Optional[str] = None
    properties: Optional[Any] = None


class AgentStateResponse(BaseModel):
    """Response body for /agents/state endpoint."""
    threadId: str
    threadExists: bool
    state: str  # JSON stringified
    messages: str  # JSON stringified


def _header_to_key(header_name: str) -> str:
    """Convert header name to state key.

    Strips 'x-' prefix and converts hyphens to underscores.
    Example: 'x-user-id' -> 'user_id', 'x-tenant-id' -> 'tenant_id'
    """
    key = header_name.lower()
    if key.startswith("x-"):
        key = key[2:]
    return key.replace("-", "_")

def make_extract_headers(headers_to_extract: list[str]) -> Callable[[Request, RunAgentInput], Coroutine[dict[str,Any], Any, Any]]:
    """
    Replicate original extract_headers functionality via custom extractor
    Create an async function to extract specified headers into state.

    Args:
        headers_to_extract: List of HTTP header names to extract into state.
    Returns:
        Async function that extracts headers into state.
    """
    async def extract_headers(request: Request, input_data: RunAgentInput) -> dict[str, Any]:
        # Extract headers into state.headers if list provided
        if headers_to_extract:
            headers_dict = {}
            for header_name in headers_to_extract:
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
                return merged_state

        return {}

    return extract_headers

def add_adk_fastapi_endpoint(
    app: FastAPI | APIRouter,
    agent: ADKAgent,
    path: str = "/",
    extract_headers: Optional[List[str]] = None,
    extract_state_from_request: Optional[Callable[[Request, RunAgentInput], Coroutine[dict[str,Any], Any, Any]]] = None,
):
    """Add ADK middleware endpoint to FastAPI app.

    Args:
        app: FastAPI application instance
        agent: Configured ADKAgent instance
        path: API endpoint path
        extract_headers: Optional list of HTTP header names to extract into state. Cannot be used with extract_state_from_request.
        extract_state_from_request: Optional async function to extract values mapped from the request into state.
            State values returned from this function will override any existing state values. 
            The RunAgentInput is provided so conflicts can be identified and resolved appropriately.
            Cannot be used with extract_headers.

    Note:
        This function also adds an experimental POST /agents/state endpoint for
        consumption by front-end frameworks that need to retrieve thread state and
        message history. This endpoint is subject to change in future versions.
    """
    extract_state_fn = extract_state_from_request
    if extract_headers is not None:
        if extract_state_from_request is None:
            warnings.warn(
                "The 'extract_headers' parameter is deprecated and will be removed in future versions. "
                "Please use 'extract_state_from_request' instead. Example: extract_state_from_request = make_extract_headers(extract_headers)",
                DeprecationWarning
            )
            # Create extractor from headers list
            extract_state_fn = make_extract_headers(extract_headers)
        else:
            raise ValueError("Cannot use both 'extract_headers' and 'extract_state_from_request' parameters together.")

    @app.post(path)
    async def adk_endpoint(input_data: RunAgentInput, request: Request):
        """ADK middleware endpoint."""

        # Extract headers into state.headers if list provided
        if extract_state_fn:
            extracted_state_dict = await extract_state_fn(request, input_data)
            
            if extracted_state_dict:
                existing_state = input_data.state if isinstance(input_data.state, dict) else {}
                merged_state = {**existing_state, **extracted_state_dict}
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
                        from ag_ui.core import EventType, RunErrorEvent
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
                    from ag_ui.core import EventType, RunErrorEvent
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

    @app.post("/agents/state")
    async def agents_state_endpoint(request_data: AgentStateRequest):
        """EXPERIMENTAL: Retrieve thread state and message history.

        This endpoint allows front-end frameworks to retrieve the current state
        and message history for a thread without initiating a new agent run.

        WARNING: This is an experimental endpoint and is subject to change in
        future versions. It is provided to support front-end frameworks that
        require on-demand access to thread state.

        Args:
            request_data: Request containing threadId and optional name/properties

        Returns:
            JSON response with threadId, threadExists, state, and messages
        """
        thread_id = request_data.threadId

        try:
            # Resolve app_name and user_id: request params > static values
            app_name = request_data.appName or agent._static_app_name
            user_id = request_data.userId or agent._static_user_id

            if not app_name or not user_id:
                return JSONResponse(content={
                    "threadId": thread_id,
                    "threadExists": False,
                    "state": "{}",
                    "messages": "[]",
                    "error": "appName and userId are required (either in request or as agent static values)"
                })

            session = None
            session_id = None

            # Fast path: check cache first
            metadata = agent._get_session_metadata(thread_id)
            if metadata:
                session_id, cached_app_name, cached_user_id = metadata
                session = await agent._session_manager._session_service.get_session(
                    session_id=session_id,
                    app_name=cached_app_name,
                    user_id=cached_user_id
                )
                # Use cached values for subsequent operations
                app_name = cached_app_name
                user_id = cached_user_id

            # Cache miss - search backend by thread_id
            if not session:
                session = await agent._session_manager._find_session_by_thread_id(
                    app_name=app_name,
                    user_id=user_id,
                    thread_id=thread_id
                )
                if session:
                    # Found - cache for future lookups
                    session_id = session.id
                    agent._session_lookup_cache[thread_id] = (session_id, app_name, user_id)

            thread_exists = session is not None

            # Get state
            state = {}
            if thread_exists:
                state = await agent._session_manager.get_session_state(
                    session_id=session_id,
                    app_name=app_name,
                    user_id=user_id
                ) or {}

            # Get messages from session events
            messages = []
            if thread_exists and hasattr(session, 'events') and session.events:
                messages = adk_events_to_messages(session.events)

            # Convert messages to dict format for JSON serialization
            messages_dict = [msg.model_dump(by_alias=True) for msg in messages]

            return JSONResponse(content={
                "threadId": thread_id,
                "threadExists": thread_exists,
                "state": json.dumps(state),
                "messages": json.dumps(messages_dict)
            })

        except Exception as e:
            logger.error(f"Error in /agents/state endpoint: {e}", exc_info=True)
            return JSONResponse(
                status_code=500,
                content={
                    "threadId": thread_id,
                    "threadExists": False,
                    "state": "{}",
                    "messages": "[]",
                    "error": str(e)
                }
            )


def create_adk_app(
    agent: ADKAgent,
    path: str = "/",
    extract_headers: Optional[List[str]] = None,
    extract_state_from_request: Optional[Callable[[Request, RunAgentInput], Coroutine[dict[str,Any], Any, Any]]] = None,
) -> FastAPI:
    """Create a FastAPI app with ADK middleware endpoint.

    Args:
        agent: Configured ADKAgent instance
        path: API endpoint path
        extract_headers: Optional list of HTTP header names to extract into state. Cannot be used with extract_state_from_request.
        extract_state_from_request: Optional async function to extract values mapped from the request into state.
            State values returned from this function will override any existing state values. 
            The RunAgentInput is provided so conflicts can be identified and resolved appropriately.
            Cannot be used with extract_headers.

    Returns:
        FastAPI application instance
    """
    app = FastAPI(title="ADK Middleware for AG-UI Protocol")
    add_adk_fastapi_endpoint(app, agent, path, extract_headers=extract_headers, extract_state_from_request=extract_state_from_request)
    return app