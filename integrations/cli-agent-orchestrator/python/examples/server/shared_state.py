"""
Shared state endpoint for the CLI Agent Orchestrator dojo.

Demonstrates real fleet state by streaming a text message followed by
a STATE_SNAPSHOT with recipe data (same scenario as server-starter-all-features).
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
    StateSnapshotEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
)
from ag_ui.encoder import EventEncoder


async def shared_state_endpoint(input_data: RunAgentInput, request: Request):
    """Shared state endpoint - streams a text response and fleet state as a snapshot."""
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

        # Send text message describing the recipe
        async for event in send_text_message():
            yield encoder.encode(event)

        # Send state events
        async for event in send_state_events():
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


async def send_text_message():
    """Stream a text message describing the recipe being loaded."""
    message_id = str(uuid.uuid4())

    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START,
        message_id=message_id,
        role="assistant",
    )

    chunks = [
        "Here's a spicy chicken lettuce wrap recipe ",
        "with low-carb ingredients. ",
        "Check the shared state panel for the full details!",
    ]

    for chunk in chunks:
        yield TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=message_id,
            delta=chunk,
        )
        await asyncio.sleep(0.05)

    yield TextMessageEndEvent(
        type=EventType.TEXT_MESSAGE_END,
        message_id=message_id,
    )


async def send_state_events():
    """Send state events with recipe data."""
    state = {
        "recipe": {
            "skill_level": "Advanced",
            "special_preferences": ["Low Carb", "Spicy"],
            "cooking_time": "15 min",
            "ingredients": [
                {
                    "icon": "\U0001f357",
                    "name": "chicken breast",
                    "amount": "1",
                },
                {
                    "icon": "\U0001f336\ufe0f",
                    "name": "chili powder",
                    "amount": "1 tsp",
                },
                {
                    "icon": "\U0001f9c2",
                    "name": "Salt",
                    "amount": "a pinch",
                },
                {
                    "icon": "\U0001f96c",
                    "name": "Lettuce leaves",
                    "amount": "handful",
                },
            ],
            "instructions": [
                "Season chicken with chili powder and salt.",
                "Sear until fully cooked.",
                "Slice and wrap in lettuce.",
            ],
        }
    }

    yield StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot=state,
    )
