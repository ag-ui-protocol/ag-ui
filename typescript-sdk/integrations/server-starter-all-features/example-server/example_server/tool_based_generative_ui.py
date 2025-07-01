"""
Tool-based generative UI endpoint for the AG-UI protocol.
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
    MessagesSnapshotEvent
)
from ag_ui.encoder import EventEncoder

async def tool_based_generative_ui_endpoint(input_data: RunAgentInput, request: Request):
    """Tool-based generative UI endpoint"""
    # Get the accept header from the request
    accept_header = request.headers.get("accept")

    # Create an event encoder to properly format SSE events
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        # Send run started event
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id
            ),
        )

        # Check if last message was a tool result
        last_message = None
        if input_data.messages and len(input_data.messages) > 0:
            last_message = input_data.messages[-1]

        # Determine what type of message to send
        if last_message and getattr(last_message, 'role', None) == "tool":
            # Send text message for tool result
            message_id = str(uuid.uuid4())
            new_message = {
                "id": message_id,
                "role": "assistant",
                "content": "Haiku created"
            }
        else:
            # Send tool call message
            tool_call_id = str(uuid.uuid4())
            message_id = str(uuid.uuid4())
            
            # Prepare haiku arguments
            haiku_args = {
                "japanese": ["エーアイの", "橋つなぐ道", "コパキット"],
                "english": [
                    "From AI's realm",
                    "A bridge-road linking us—",
                    "CopilotKit."
                ]
            }

            # Create new assistant message with tool call
            new_message = {
                "id": message_id,
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": tool_call_id,
                        "type": "function",
                        "function": {
                            "name": "generate_haiku",
                            "arguments": json.dumps(haiku_args)
                        }
                    }
                ]
            }

        # Create messages list with input messages plus the new message
        all_messages = list(input_data.messages) + [new_message]

        # Send messages snapshot event
        yield encoder.encode(
            MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=all_messages
            ),
        )

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
