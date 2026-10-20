"""
Server-managed history example (prototype for ag-ui-protocol/ag-ui#2186).

In this mode the server owns the conversation. A client that supports the
mode (the client side is a separate prototype and not yet in the released
SDKs) uploads only the messages the server has not confirmed yet and names
the last confirmed message in ``forwardedProps["ag-ui:historyCursor"]``.
Clients without that support keep sending their full history without a
cursor, which this endpoint also accepts. The server:

1. Rejects runs whose cursor it cannot resolve with a RUN_ERROR whose code is
   ``HISTORY_UNAVAILABLE``. A supporting client then retries once with its
   full history.
2. Treats everything the client sends as untrusted input. It never overwrites
   a stored message, accepts only ``user`` messages and ``tool`` messages that
   answer a pending tool call, and drops ``assistant``, ``system`` and
   ``developer`` messages as well as orphan ``tool`` messages.
3. Builds the model context from its own store, never from
   ``RunAgentInput.messages``.

The store is a plain in-memory dict so the example stays readable. A real
deployment would persist threads and scope them to the authenticated user.
"""

import asyncio
import uuid
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from ag_ui.core import (
    PROTOCOL_VERSION,
    AgentCapabilities,
    AssistantMessage,
    EventType,
    Message,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolMessage,
    UserMessage,
)
from ag_ui.encoder import EventEncoder

HISTORY_CURSOR_KEY = "ag-ui:historyCursor"
HISTORY_UNAVAILABLE = "HISTORY_UNAVAILABLE"

router = APIRouter()

# threadId -> messages in conversation order. In-memory, demo only.
THREADS: dict[str, list[Message]] = {}
THREAD_LOCKS: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def get_history_cursor(input_data: RunAgentInput) -> Optional[str]:
    """Read the client's history cursor from forwardedProps, if any."""
    props = input_data.forwarded_props
    if isinstance(props, dict):
        cursor = props.get(HISTORY_CURSOR_KEY)
        if isinstance(cursor, str):
            return cursor
    return None


def pending_tool_call_ids(history: list[Message]) -> set[str]:
    """Tool call ids the assistant issued that no stored tool message answers."""
    issued: set[str] = set()
    answered: set[str] = set()
    for message in history:
        if isinstance(message, AssistantMessage):
            issued.update(call.id for call in message.tool_calls or [])
        elif isinstance(message, ToolMessage):
            answered.add(message.tool_call_id)
    return issued - answered


def accept_client_messages(
    history: list[Message], incoming: list[Message]
) -> list[Message]:
    """Return the incoming messages the server is willing to store.

    Applies the trust rules: ids already stored are ignored (never
    overwritten), only user messages and tool results for pending tool calls
    are accepted, everything else is dropped.
    """
    known_ids = {message.id for message in history}
    pending = pending_tool_call_ids(history)
    accepted: list[Message] = []
    for message in incoming:
        if message.id in known_ids:
            continue
        if isinstance(message, UserMessage):
            pass
        elif isinstance(message, ToolMessage) and message.tool_call_id in pending:
            pending.discard(message.tool_call_id)
        else:
            continue
        known_ids.add(message.id)
        accepted.append(message)
    return accepted


def build_reply(history: list[Message]) -> str:
    """Stand-in for a model call: describe the context the server would send.

    The numbers come from the server store, so a client cannot inflate or
    rewrite them by resending or forging messages.
    """
    turn = 1 + sum(isinstance(m, AssistantMessage) for m in history)
    user_messages = sum(isinstance(m, UserMessage) for m in history)
    return f"Turn {turn}, {user_messages} user messages in server context."


@router.get("/capabilities")
async def server_history_capabilities() -> dict:
    """Advertise server-managed history.

    The draft spec adds ``state.serverManagedHistory``. The 1.0 types are
    generated from the frozen 1.0 schema, so the flag travels under ``custom``
    until the field is part of a released schema.
    """
    capabilities = AgentCapabilities(custom={"serverManagedHistory": True})
    return capabilities.model_dump(by_alias=True, exclude_none=True)


@router.post("")
async def server_history_endpoint(input_data: RunAgentInput, request: Request):
    """Chat endpoint whose conversation history lives on the server."""
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def event_generator():
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
                protocol_version=PROTOCOL_VERSION,
            )
        )

        # One run per thread at a time, so overlapping requests (a double
        # submit, or a retry racing the original) cannot interleave history.
        async with THREAD_LOCKS[input_data.thread_id]:
            history = THREADS.get(input_data.thread_id, [])
            cursor = get_history_cursor(input_data)

            # The client claims to share history with us. If we cannot find
            # the cursor, ask it to resend instead of guessing. A cursor that
            # points at an older stored message is fine: the client is
            # behind, and the trust rules below skip whatever it resends.
            if cursor is not None and all(m.id != cursor for m in history):
                yield encoder.encode(
                    RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        code=HISTORY_UNAVAILABLE,
                        message=(
                            f"History for thread '{input_data.thread_id}' is not "
                            f"available at cursor '{cursor}'. Resend the full history."
                        ),
                    )
                )
                return

            # Without a cursor this is either a new thread or the client's
            # full history retry. Both go through the same trust rules, so
            # stored messages win and forged ones are dropped.
            accepted = accept_client_messages(history, input_data.messages)
            context = history + accepted  # what a real agent sends the model
            reply = AssistantMessage(
                id=str(uuid.uuid4()),
                role="assistant",
                content=build_reply(context),
            )

            yield encoder.encode(
                TextMessageStartEvent(
                    type=EventType.TEXT_MESSAGE_START,
                    message_id=reply.id,
                    role="assistant",
                )
            )
            yield encoder.encode(
                TextMessageContentEvent(
                    type=EventType.TEXT_MESSAGE_CONTENT,
                    message_id=reply.id,
                    delta=reply.content,
                )
            )
            yield encoder.encode(
                TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END,
                    message_id=reply.id,
                )
            )
            yield encoder.encode(
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED,
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                )
            )

            # Commit only after RUN_FINISHED was handed to the transport. If
            # the client disconnects earlier, the generator is closed at a
            # yield and nothing is stored: the client never confirmed these
            # messages either, so it resends them on its next run.
            THREADS[input_data.thread_id] = context + [reply]

    return StreamingResponse(
        event_generator(), media_type=encoder.get_content_type()
    )
