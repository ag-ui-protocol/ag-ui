"""FastAPI endpoint utilities for AWS Strands integration."""

import asyncio
from typing import Any

from ag_ui.core import EventType, RunAgentInput, RunErrorEvent
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from .agent import (
    StrandsAgent,
    _cancellation_from_exception_chain,
    _drain_cleanup,
)


async def _close_async_iterator(
    stream: Any,
    *,
    owner: str,
    caller_cancellation: asyncio.CancelledError | None = None,
    observed_cleanup_error: BaseException | None = None,
) -> None:
    async def cleanup() -> None:
        await stream.aclose()

    await _drain_cleanup(
        cleanup,
        cancellation_error_message=(
            "Endpoint stream cleanup failed during caller cancellation"
        ),
        log_context={"cleanup_owner": owner},
        caller_cancellation=caller_cancellation,
        observed_cleanup_error=observed_cleanup_error,
    )


class _ClosingStreamingResponse(StreamingResponse):
    """Streaming response that explicitly owns and closes its body iterator."""

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        caller_cancellation: asyncio.CancelledError | None = None
        observed_cleanup_error: BaseException | None = None
        try:
            await super().__call__(scope, receive, send)
        except asyncio.CancelledError as exc:
            caller_cancellation = exc
            raise
        except BaseException as exc:
            caller_cancellation = _cancellation_from_exception_chain(exc)
            if caller_cancellation is not None:
                observed_cleanup_error = exc
            raise
        finally:
            await _close_async_iterator(
                self.body_iterator,
                owner="endpoint_body_iterator",
                caller_cancellation=caller_cancellation,
                observed_cleanup_error=observed_cleanup_error,
            )


def add_strands_fastapi_endpoint(
    app: FastAPI,
    agent: StrandsAgent,
    path: str,
    **kwargs,
) -> None:
    """Add a Strands agent endpoint to FastAPI app."""

    @app.post(path)
    async def strands_endpoint(input_data: RunAgentInput, request: Request):
        """AWS Strands agent endpoint."""
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)

        async def event_generator():
            run_stream = agent.run(input_data)
            caller_cancellation: asyncio.CancelledError | None = None
            observed_cleanup_error: BaseException | None = None
            try:
                async for event in run_stream:
                    try:
                        yield encoder.encode(event)
                    except Exception as exc:
                        error_event = RunErrorEvent(
                            type=EventType.RUN_ERROR,
                            message=f"Encoding error: {str(exc)}",
                            code="ENCODING_ERROR",
                        )
                        yield encoder.encode(error_event)
                        break
            except asyncio.CancelledError as exc:
                caller_cancellation = exc
                raise
            except BaseException as exc:
                caller_cancellation = _cancellation_from_exception_chain(exc)
                if caller_cancellation is not None:
                    observed_cleanup_error = exc
                raise
            finally:
                await _close_async_iterator(
                    run_stream,
                    owner="agent_run_stream",
                    caller_cancellation=caller_cancellation,
                    observed_cleanup_error=observed_cleanup_error,
                )

        return _ClosingStreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type(),
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
