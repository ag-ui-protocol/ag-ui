"""
Interrupt endpoint for the CLI Agent Orchestrator dojo.

This is the flagship feature demonstrating the ag-ui interrupt lifecycle:
- First run (no resume[]): streams RUN_STARTED, STATE_SNAPSHOT with fleet context,
  then RUN_FINISHED with outcome={type:"interrupt"} containing an approval request.
- Resume run (with resume[]): processes the decision, streams a text response
  confirming approval or denial, then RUN_FINISHED with outcome={type:"success"}.
"""

import uuid
import asyncio
from fastapi import Request
from fastapi.responses import StreamingResponse
from ag_ui.core import (
    RunAgentInput,
    EventType,
    Interrupt,
    RunStartedEvent,
    RunFinishedEvent,
    StateSnapshotEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
)
from ag_ui.core.events import (
    RunFinishedInterruptOutcome,
    RunFinishedSuccessOutcome,
)
from ag_ui.encoder import EventEncoder


async def interrupt_endpoint(input_data: RunAgentInput, request: Request):
    """Interrupt endpoint - demonstrates the ag-ui interrupt/approval lifecycle."""
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

        # Check if this is a resume (has resume entries)
        if input_data.resume and len(input_data.resume) > 0:
            # Resume flow: process the decision and confirm
            async for event in handle_resume(input_data):
                yield encoder.encode(event)

            # Finish with success outcome
            yield encoder.encode(
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=RunFinishedSuccessOutcome(type="success"),
                ),
            )
        else:
            # Initial flow: emit state snapshot then interrupt
            async for event in send_initial_state():
                yield encoder.encode(event)

            # Finish with interrupt outcome
            interrupt_id = str(uuid.uuid4())
            yield encoder.encode(
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=RunFinishedInterruptOutcome(
                        type="interrupt",
                        interrupts=[
                            Interrupt(
                                id=interrupt_id,
                                reason="claude-code:permission_request",
                                message="Allow file write to src/config.ts?",
                                metadata={
                                    "provider": "claude_code",
                                    "terminalId": "t1",
                                    "command": "Write to src/config.ts",
                                },
                            )
                        ],
                    ),
                ),
            )

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type(),
    )


async def send_initial_state():
    """Send a state snapshot representing the fleet context before the interrupt."""
    state = {
        "fleet": {
            "active_agents": 2,
            "pending_approvals": 1,
            "terminals": [
                {
                    "id": "t1",
                    "agent": "claude-code",
                    "status": "awaiting_approval",
                    "task": "Refactor config module",
                },
                {
                    "id": "t2",
                    "agent": "claude-code",
                    "status": "running",
                    "task": "Write unit tests",
                },
            ],
        }
    }

    yield StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot=state,
    )


async def handle_resume(input_data: RunAgentInput):
    """Handle a resume by confirming the user's decision."""
    message_id = str(uuid.uuid4())
    resume_entry = input_data.resume[0]

    if resume_entry.status == "resolved":
        response_text = (
            "Permission granted. The agent is now writing to `src/config.ts`. "
            "Fleet status updated."
        )
    else:
        response_text = (
            "Permission denied. The agent has been notified and will skip "
            "the file write operation."
        )

    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START,
        message_id=message_id,
        role="assistant",
    )

    # Stream the response in chunks for a natural feel
    words = response_text.split(" ")
    chunk_size = 3
    for i in range(0, len(words), chunk_size):
        chunk = " ".join(words[i : i + chunk_size])
        if i + chunk_size < len(words):
            chunk += " "
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
