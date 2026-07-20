"""
Agentic chat endpoint for the CLI Agent Orchestrator dojo.

Simulates an agentic conversation about CLI agent orchestration
without requiring a real CAO backend.
"""

import uuid
import asyncio
from fastapi import Request
from fastapi.responses import StreamingResponse
from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
)
from ag_ui.encoder import EventEncoder


async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
    """Agentic chat endpoint - streams a simulated response about CLI agent orchestration."""
    accept_header = request.headers.get("accept")
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        # Send run started event
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            ),
        )

        # Stream text message
        async for event in send_chat_response():
            yield encoder.encode(event)

        # Send run finished event
        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            ),
        )

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type(),
    )


async def send_chat_response():
    """Stream a simulated response about CLI agent orchestration."""
    message_id = str(uuid.uuid4())

    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START,
        message_id=message_id,
        role="assistant",
    )

    chunks = [
        "The **CLI Agent Orchestrator** (CAO) ",
        "manages multiple AI coding agents ",
        "running in parallel across your fleet.\n\n",
        "Key capabilities:\n",
        "- **Fleet management** - spin up and coordinate agents across terminals\n",
        "- **Interrupt handling** - approve or deny tool calls in real-time\n",
        "- **Shared state** - track progress across all active agents\n",
        "- **Human-in-the-loop** - review and approve generated task plans\n\n",
        "This dojo demonstrates these patterns using the AG-UI protocol.",
    ]

    for chunk in chunks:
        yield TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=message_id,
            delta=chunk,
        )
        await asyncio.sleep(0.1)

    yield TextMessageEndEvent(
        type=EventType.TEXT_MESSAGE_END,
        message_id=message_id,
    )
