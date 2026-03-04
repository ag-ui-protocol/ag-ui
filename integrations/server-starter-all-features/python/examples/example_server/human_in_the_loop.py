"""
Human in the loop endpoint for the AG-UI protocol.
"""

import uuid
import asyncio
import json
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
    ToolCallEndEvent
)
from ag_ui.encoder import EventEncoder

async def human_in_the_loop_endpoint(input_data: RunAgentInput, request: Request):
    """Human in the loop endpoint"""
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


async def send_tool_call_events():
    """Send tool call events that generate task steps incrementally"""
    tool_call_id = str(uuid.uuid4())
    tool_call_name = "generate_task_steps"

    # Tool call start
    yield ToolCallStartEvent(
        type=EventType.TOOL_CALL_START,
        tool_call_id=tool_call_id,
        tool_call_name=tool_call_name
    )

    # Start building JSON - opening structure
    yield ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id=tool_call_id,
        delta='{"steps":['
    )

    # Generate 10 steps incrementally
    for i in range(10):
        step_data = {
            "description": f"Step {i + 1}",
            "status": "enabled"
        }
        
        # Add comma separator except for the last item
        delta = json.dumps(step_data) + ("," if i != 9 else "")
        
        yield ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=tool_call_id,
            delta=delta
        )
        
        # Sleep for 200ms
        await asyncio.sleep(0.2)

    # Close JSON structure
    yield ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id=tool_call_id,
        delta="]}"
    )

    # Tool call end
    yield ToolCallEndEvent(
        type=EventType.TOOL_CALL_END,
        tool_call_id=tool_call_id
    )


async def send_text_message_events():
    """Send text message events with simple response"""
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
        delta="Ok! I'm working on it."
    )

    # End of message
    yield TextMessageEndEvent(
        type=EventType.TEXT_MESSAGE_END,
        message_id=message_id
    )
