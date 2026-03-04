"""
Agentic chat endpoint for the AG-UI protocol.
"""

import uuid
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
    MessagesSnapshotEvent,
    ToolMessage,
    ToolCall,
    AssistantMessage,
)
from ag_ui.encoder import EventEncoder


async def backend_tool_rendering_endpoint(input_data: RunAgentInput, request: Request):
    """Agentic chat endpoint"""
    # Get the accept header from the request
    accept_header = request.headers.get("accept")

    # Create an event encoder to properly format SSE events
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        # Get the last message content for conditional logic
        last_message_role = None
        if input_data.messages and len(input_data.messages) > 0:
            last_message = input_data.messages[-1]
            last_message_role = getattr(last_message, "role", None)

        # Send run started event
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            ),
        )

        # Conditional logic based on last message
        if last_message_role == "tool":
            async for event in send_tool_result_message_events():
                yield encoder.encode(event)
        else:
            async for event in send_backend_tool_call_events(input_data.messages):
                yield encoder.encode(event)

        # Send run finished event
        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            ),
        )

    return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


async def send_tool_result_message_events():
    """Send message for tool result"""
    message_id = str(uuid.uuid4())

    # Start of message
    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START, message_id=message_id, role="assistant"
    )

    # Content
    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT,
        message_id=message_id,
        delta="Retrieved weather information!",
    )

    # End of message
    yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id)


async def send_backend_tool_call_events(messages: list):
    """Send backend tool call events"""
    tool_call_id = str(uuid.uuid4())

    new_message = AssistantMessage(
        id=str(uuid.uuid4()),
        role="assistant",
        tool_calls=[
            ToolCall(
                id=tool_call_id,
                type="function",
                function={
                    "name": "get_weather",
                    "arguments": json.dumps({"city": "San Francisco"}),
                },
            )
        ],
    )

    result_message = ToolMessage(
        id=str(uuid.uuid4()),
        role="tool",
        content=json.dumps(
            {
                "city": "San Francisco",
                "conditions": "sunny",
                "wind_speed": "10",
                "temperature": "20",
                "humidity": "60",
            }
        ),
        tool_call_id=tool_call_id,
    )

    all_messages = list(messages) + [new_message, result_message]

    # Send messages snapshot event
    yield MessagesSnapshotEvent(type=EventType.MESSAGES_SNAPSHOT, messages=all_messages)
