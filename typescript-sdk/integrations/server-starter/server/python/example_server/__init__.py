"""
Example server for the AG-UI protocol.
"""

import os
import uvicorn
import uuid
import asyncio
from typing import Any, List
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    StateSnapshotEvent,
    StateDeltaEvent,
)
from ag_ui.encoder import EventEncoder

app = FastAPI(title="AG-UI Endpoint")

@app.post("/")
async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
    """Agentic chat endpoint"""
    # Get the accept header from the request
    accept_header = request.headers.get("accept")

    # Create an event encoder to properly format SSE events
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        # Run started
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
        )

        # Standard text BEFORE thinking
        pre_msg_id = str(uuid.uuid4())
        yield encoder.encode(TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id=pre_msg_id,
            role="assistant",
        ))
        yield encoder.encode(TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=pre_msg_id,
            delta="Let me think this through and I will share my reasoning steps briefly.",
        ))
        yield encoder.encode(TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id=pre_msg_id,
        ))

        # Initial empty state snapshot: {}
        yield encoder.encode(StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot={}
        ))

        # Thoughts to stream
        thoughts = [
            "Let me think about your question a little bit.",
            "I am thinking very very hard about your problem",
            "I am almost done!",
        ]

        # Helper to split a thought into two halves
        def split_thought(t: str):
            mid = max(1, len(t) // 2)
            return t[:mid], t[mid:]

        # Stream thoughts via JSON Patch:
        # - add current_thoughts array on first update
        # - add each item with first half
        # - replace same item with full text
        for i, thought in enumerate(thoughts):
            first_half, second_half = split_thought(thought)

            ops: List[Any] = []
            if i == 0:
                ops.append({"op": "add", "path": "/current_thoughts", "value": []})
            ops.append({
                "op": "add",
                "path": f"/current_thoughts/{i}",
                "value": {"thought_text": first_half}
            })
            yield encoder.encode(StateDeltaEvent(
                type=EventType.STATE_DELTA,
                delta=ops
            ))
            await asyncio.sleep(0.2)

            yield encoder.encode(StateDeltaEvent(
                type=EventType.STATE_DELTA,
                delta=[{
                    "op": "replace",
                    "path": f"/current_thoughts/{i}/thought_text",
                    "value": first_half + second_half
                }]
            ))
            await asyncio.sleep(5)

        # Snapshot the final thinking state
        yield encoder.encode(StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot={"current_thoughts": [{"thought_text": t} for t in thoughts]}
        ))

        # Wait for 30 seconds, so thoughts are visible in this example
        await asyncio.sleep(30)

        # Standard text AFTER thinking
        post_msg_id = str(uuid.uuid4())
        yield encoder.encode(TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id=post_msg_id,
            role="assistant",
        ))
        yield encoder.encode(TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=post_msg_id,
            delta="Done thinking. Here is the result.",
        ))
        yield encoder.encode(TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id=post_msg_id,
        ))

        # Clear the state at the end: {}
        # If you wish to persist thoughts, add them to any future snapshots, like this one
        yield encoder.encode(StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot={}
        ))

        # Run finished
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

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "example_server:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )
