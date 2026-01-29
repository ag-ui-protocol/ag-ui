"""FastAPI endpoint factory for OpenResponses agent."""

from __future__ import annotations

import logging
from typing import Any, Callable, Coroutine

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import StreamingResponse

from .agent import OpenResponsesAgent

logger = logging.getLogger(__name__)


def create_openresponses_endpoint(
    app: FastAPI | APIRouter,
    agent: OpenResponsesAgent,
    path: str = "/",
    extract_state_from_request: Callable[
        [Request, RunAgentInput], Coroutine[Any, Any, dict[str, Any]]
    ]
    | None = None,
) -> None:
    """Add OpenResponses agent endpoint to FastAPI app.

    Args:
        app: FastAPI application or APIRouter instance.
        agent: Configured OpenResponsesAgent instance.
        path: API endpoint path (default: "/").
        extract_state_from_request: Optional async function to extract values
            from the request into state. State values returned from this
            function will be merged with existing state values.

    Example:
        ```python
        from fastapi import FastAPI
        from ag_ui_openresponses import (
            create_openresponses_endpoint,
            OpenResponsesAgent,
            OpenResponsesAgentConfig,
        )

        app = FastAPI()

        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key="your-api-key",
            )
        )

        create_openresponses_endpoint(app, agent, path="/agent")
        ```
    """

    @app.post(path)
    async def openresponses_endpoint(input_data: RunAgentInput, request: Request):
        """OpenResponses agent endpoint."""

        # Extract additional state from request if extractor provided
        if extract_state_from_request:
            extracted_state_dict = await extract_state_from_request(request, input_data)

            if extracted_state_dict:
                existing_state = (
                    input_data.state if isinstance(input_data.state, dict) else {}
                )
                merged_state = {**existing_state, **extracted_state_dict}
                input_data = input_data.model_copy(update={"state": merged_state})

        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        async def event_generator():
            """Generate events from OpenResponses agent."""
            try:
                async for event in agent.run(input_data):
                    try:
                        encoded = encoder.encode(event)
                        logger.debug(f"HTTP Response: {encoded}")
                        yield encoded
                    except Exception as encoding_error:
                        logger.error(
                            f"Event encoding error: {encoding_error}", exc_info=True
                        )
                        error_event = RunErrorEvent(
                            type=EventType.RUN_ERROR,
                            message=f"Event encoding failed: {str(encoding_error)}",
                            code="ENCODING_ERROR",
                        )
                        try:
                            error_encoded = encoder.encode(error_event)
                            yield error_encoded
                        except Exception:
                            logger.error(
                                "Failed to encode error event, yielding basic SSE error"
                            )
                            yield 'event: error\ndata: {"error": "Event encoding failed"}\n\n'
                        break

            except Exception as agent_error:
                logger.error(f"Agent error: {agent_error}", exc_info=True)
                try:
                    error_event = RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=f"Agent execution failed: {str(agent_error)}",
                        code="AGENT_ERROR",
                    )
                    error_encoded = encoder.encode(error_event)
                    yield error_encoded
                except Exception:
                    logger.error(
                        "Failed to encode agent error event, yielding basic SSE error"
                    )
                    yield 'event: error\ndata: {"error": "Agent execution failed"}\n\n'

        return StreamingResponse(
            event_generator(), media_type=encoder.get_content_type()
        )
