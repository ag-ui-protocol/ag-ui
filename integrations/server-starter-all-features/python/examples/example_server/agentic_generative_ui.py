"""
Agentic generative UI endpoint for the AG-UI protocol.
"""

import asyncio
import copy
import jsonpatch
from fastapi import Request
from fastapi.responses import StreamingResponse
from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    StateSnapshotEvent,
    StateDeltaEvent
)
from ag_ui.encoder import EventEncoder

async def agentic_generative_ui_endpoint(input_data: RunAgentInput, request: Request):
    """Agentic generative UI endpoint"""
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

        # Send state events
        async for event in send_state_events():
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


async def send_state_events():
    """Send state events with snapshots and deltas"""
    # Initialize state
    state = {
        "steps": [
            {
                "description": f"Step {i + 1}",
                "status": "pending"
            }
            for i in range(10)
        ]
    }

    # Send initial state snapshot
    yield StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot=state
    )
    
    # Sleep for 1 second
    await asyncio.sleep(1.0)

    # Create a copy to track changes for JSON patches
    previous_state = copy.deepcopy(state)

    # Update each step and send deltas
    for i, step in enumerate(state["steps"]):
        step["status"] = "completed"
        
        # Generate JSON patch from previous state to current state
        patch = jsonpatch.make_patch(previous_state, state)
        
        # Send state delta event
        yield StateDeltaEvent(
            type=EventType.STATE_DELTA,
            delta=patch.patch
        )
        
        # Update previous state for next iteration
        previous_state = copy.deepcopy(state)
        
        # Sleep for 1 second
        await asyncio.sleep(1.0)

    # Optionally send a final snapshot to the client
    yield StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot=state
    )
