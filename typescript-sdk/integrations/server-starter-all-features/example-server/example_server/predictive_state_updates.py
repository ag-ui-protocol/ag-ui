"""
Predictive state updates endpoint for the AG-UI protocol.
"""

import uuid
import asyncio
import random
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
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    CustomEvent
)
from ag_ui.encoder import EventEncoder

async def predictive_state_updates_endpoint(input_data: RunAgentInput, request: Request):
    """Predictive state updates endpoint"""
    # Get the accept header from the request
    accept_header = request.headers.get("accept")

    # Create an event encoder to properly format SSE events
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        # Get the last message for conditional logic
        last_message = None
        if input_data.messages and len(input_data.messages) > 0:
            last_message = input_data.messages[-1]

        # Send run started event
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            ),
        )

        # Conditional logic based on last message role
        if last_message and getattr(last_message, 'role', None) == "tool":
            async for event in send_text_message_events():
                yield encoder.encode(event)
        else:
            async for event in send_tool_call_events():
                yield encoder.encode(event)

        # Send run finished event
        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            ),
        )

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type()
    )


def make_story(name: str) -> str:
    """Generate a simple dog story"""
    return f"Once upon a time, there was a dog named {name}. {name} was a very good dog."


# List of dog names for random selection
dog_names = ["Rex", "Buddy", "Max", "Charlie", "Buddy", "Max", "Charlie"]


async def send_tool_call_events():
    """Send tool call events with predictive state and incremental story generation"""
    tool_call_id = str(uuid.uuid4())
    tool_call_name = "write_document"

    # Generate a random story
    story = make_story(random.choice(dog_names))
    story_chunks = story.split(" ")

    # Send custom predict state event first
    yield CustomEvent(
        type=EventType.CUSTOM,
        name="PredictState",
        value=[
            {
                "state_key": "document",
                "tool": "write_document",
                "tool_argument": "document"
            }
        ]
    )

    # First tool call: write_document
    yield ToolCallStartEvent(
        type=EventType.TOOL_CALL_START,
        tool_call_id=tool_call_id,
        tool_call_name=tool_call_name
    )

    # Start JSON arguments
    yield ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id=tool_call_id,
        delta='{"document":"'
    )

    # Send story chunks incrementally
    for chunk in story_chunks:
        yield ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=tool_call_id,
            delta=chunk + " "
        )
        await asyncio.sleep(0.2)  # 200ms delay

    # Close JSON arguments
    yield ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id=tool_call_id,
        delta='"}'
    )

    # End first tool call
    yield ToolCallEndEvent(
        type=EventType.TOOL_CALL_END,
        tool_call_id=tool_call_id
    )

    # Second tool call: confirm_changes
    tool_call_id_2 = str(uuid.uuid4())
    tool_call_name_2 = "confirm_changes"

    yield ToolCallStartEvent(
        type=EventType.TOOL_CALL_START,
        tool_call_id=tool_call_id_2,
        tool_call_name=tool_call_name_2
    )

    yield ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id=tool_call_id_2,
        delta="{}"
    )

    yield ToolCallEndEvent(
        type=EventType.TOOL_CALL_END,
        tool_call_id=tool_call_id_2
    )


async def send_text_message_events():
    """Send simple text message events"""
    message_id = str(uuid.uuid4())

    # Start of message
    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START,
        message_id=message_id,
        role="assistant"
    )

    # Content
    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT,
        message_id=message_id,
        delta="Ok!"
    )

    # End of message
    yield TextMessageEndEvent(
        type=EventType.TEXT_MESSAGE_END,
        message_id=message_id
    )
