"""AG-UI adapter for Swarms agents."""
import uuid
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from swarms import Agent

from ag_ui.core import (
    EventType,
    Message,
    MessagesSnapshotEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from ag_ui.core.types import AssistantMessage
from ag_ui.encoder import EventEncoder


async def _event_stream(
    agent: Agent,
    body: RunAgentInput,
    encoder: EventEncoder,
) -> AsyncIterator[str]:
    run_id = body.run_id or str(uuid.uuid4())
    thread_id = body.thread_id or str(uuid.uuid4())
    message_id = str(uuid.uuid4())

    last_user = next(
        (m for m in reversed(body.messages) if m.role == "user"), None
    )
    task = last_user.content if last_user else ""

    yield encoder.encode(
        RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=thread_id,
            run_id=run_id,
        )
    )
    yield encoder.encode(
        TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id=message_id,
            role="assistant",
        )
    )

    try:
        response: str = agent.run(task)
    except Exception as exc:  # pylint: disable=broad-exception-caught
        yield encoder.encode(
            RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(exc),
                code="SWARMS_RUN_ERROR",
            )
        )
        return

    yield encoder.encode(
        TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=message_id,
            delta=response,
        )
    )
    yield encoder.encode(
        TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id=message_id,
        )
    )

    snapshot: list[Message] = list(body.messages) + [
        AssistantMessage(
            id=message_id,
            role="assistant",
            content=response,
        )
    ]
    yield encoder.encode(
        MessagesSnapshotEvent(
            type=EventType.MESSAGES_SNAPSHOT,
            messages=snapshot,
        )
    )
    yield encoder.encode(
        RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=thread_id,
            run_id=run_id,
        )
    )


def add_swarms_fastapi_endpoint(
    app: FastAPI,
    agent: Agent,
    path: str = "/",
) -> None:
    """Register a POST endpoint on *app* that wraps *agent* as an AG-UI SSE stream."""

    @app.post(path)
    async def swarms_endpoint(body: RunAgentInput, request: Request):
        encoder = EventEncoder(accept=request.headers.get("accept"))
        return StreamingResponse(
            _event_stream(agent, body, encoder),
            media_type=encoder.get_content_type(),
        )
