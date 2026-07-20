"""
Human-in-the-loop endpoint for the CLI Agent Orchestrator dojo.

Implements the generate_task_steps contract: streams tool call events
with step data, and on follow-up (tool result in messages) streams
a text response confirming execution.
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
    ToolCallEndEvent,
)
from ag_ui.encoder import EventEncoder


async def human_in_the_loop_endpoint(input_data: RunAgentInput, request: Request):
    """Human-in-the-loop endpoint - generates task steps for user approval."""
    accept_header = request.headers.get("accept")
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        last_message = None
        if input_data.messages and len(input_data.messages) > 0:
            last_message = input_data.messages[-1]

        # Send run started event
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            ),
        )

        # If last message is a tool result, send text confirmation
        if last_message and getattr(last_message, "role", None) == "tool":
            async for event in send_text_message_events():
                yield encoder.encode(event)
        else:
            # Otherwise, generate task steps as tool call
            async for event in send_tool_call_events():
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


async def send_tool_call_events():
    """Send tool call events that generate task steps incrementally."""
    tool_call_id = str(uuid.uuid4())
    tool_call_name = "generate_task_steps"

    yield ToolCallStartEvent(
        type=EventType.TOOL_CALL_START,
        tool_call_id=tool_call_id,
        tool_call_name=tool_call_name,
    )

    # Start building JSON
    yield ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id=tool_call_id,
        delta='{"steps":[',
    )

    steps = [
        {"description": "Clone the repository", "status": "enabled"},
        {"description": "Install dependencies with uv sync", "status": "enabled"},
        {"description": "Run linting checks", "status": "enabled"},
        {"description": "Execute test suite", "status": "enabled"},
        {"description": "Build the package", "status": "enabled"},
    ]

    for i, step in enumerate(steps):
        delta = json.dumps(step) + ("," if i < len(steps) - 1 else "")
        yield ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=tool_call_id,
            delta=delta,
        )
        await asyncio.sleep(0.2)

    # Close JSON structure
    yield ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id=tool_call_id,
        delta="]}",
    )

    yield ToolCallEndEvent(
        type=EventType.TOOL_CALL_END,
        tool_call_id=tool_call_id,
    )


async def send_text_message_events():
    """Send text message events confirming task execution."""
    message_id = str(uuid.uuid4())

    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START,
        message_id=message_id,
        role="assistant",
    )

    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT,
        message_id=message_id,
        delta="Task steps approved! Executing the plan now.",
    )

    yield TextMessageEndEvent(
        type=EventType.TEXT_MESSAGE_END,
        message_id=message_id,
    )
