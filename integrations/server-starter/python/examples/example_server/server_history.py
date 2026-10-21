"""
Server-managed history example (prototype for ag-ui-protocol/ag-ui#2186).

In this mode the server owns the conversation. A client that supports the
mode uploads only the messages the server has not confirmed yet and names the
latest confirmed message in ``forwardedProps["ag-ui:historyCursor"]``.
Clients without that support keep sending their full history without a
cursor, which this endpoint also accepts.

What the endpoint does on every run:

1. **Cursor check.** A cursor the server cannot find in the thread (unknown
   thread, unknown or forged id) is answered with ``RUN_ERROR`` and code
   ``HISTORY_UNAVAILABLE`` right after ``RUN_STARTED``. A supporting client
   then retries once with its full history and no cursor. A cursor that
   points at an older stored message is fine: the client is behind, and the
   trust rules below skip whatever it resends.
2. **Trust rules.** Everything the client sends is untrusted input. A stored
   id is never overwritten (a resent message, including the owning assistant
   message a client sends next to a tool result, is ignored). Only ``user``
   messages and ``tool`` results that answer a pending tool call are stored,
   tool results first, so a result keeps following the assistant turn that
   called the tool. ``assistant`` messages, orphan ``tool`` messages and
   anything else are dropped. Accepted messages are stored as sanitized
   copies (no ``encrypted_value``, ``subagent_run_id`` or unknown fields).
3. **Instructions.** ``system`` and ``developer`` messages are read on every
   run and used for that run only. They are never stored and never appear in
   a ``MESSAGES_SNAPSHOT``. Whether a server honours client instructions at
   all is server policy; this example counts them in its reply.
4. **Context from the store.** The model context is built from the store,
   never from ``RunAgentInput.messages``. The run ends with a
   ``MESSAGES_SNAPSHOT`` of the stored thread (including this run's reply),
   so a lagging client catches up and every snapshot id is a valid cursor.
5. **Commit after RUN_FINISHED.** A run's messages are stored only after
   ``RUN_FINISHED`` was handed to the transport, which is also when the
   client confirms them. Runs on the same thread are serialized.

Requests without a cursor:

* **Unknown thread (fresh start).** Only ``user`` messages survive the trust
  rules: there is no stored tool call a resent ``tool`` result could answer,
  and resent ``assistant`` turns are client claims. This is the strict policy
  for the full-history retry after ``HISTORY_UNAVAILABLE``: the server starts
  a fresh thread from the user's own words instead of importing a history it
  cannot verify.
* **Known thread (divergence resend).** A client whose confirmed history
  changed (edit, rewind, regenerate) resends its full history without a
  cursor. Ids the server already holds are ignored, so the stored thread wins,
  and new ``user`` messages (plus results for pending tool calls) are
  appended. A server that wants to honour an edit or rewind would have to
  branch or reset the thread here; this example does not.

Frontend tool round trip: when the newest accepted user message contains the
word ``FRONTEND_TOOL_TRIGGER`` and the client declared a tool named
``FRONTEND_TOOL_NAME`` in ``RunAgentInput.tools``, the reply also calls that
tool. The call is stored as pending, and a later run accepts the client's
``tool`` result for it. A call the user moved past (a user message was stored
after it) is abandoned, so a late result is dropped instead of landing after
later user turns.

The reply text (see :func:`build_reply`) is computed from the store, which
makes it easy to check where the context came from. The store is a plain
in-memory dict so the example stays readable. A real deployment would persist
threads and scope them to the authenticated user.
"""

import asyncio
import json
import re
import uuid
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from ag_ui.core import (
    PROTOCOL_VERSION,
    AgentCapabilities,
    AssistantMessage,
    DeveloperMessage,
    EventType,
    FunctionCall,
    Message,
    MessagesSnapshotEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    SystemMessage,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ToolMessage,
    UserMessage,
)
from ag_ui.encoder import EventEncoder

HISTORY_CURSOR_KEY = "ag-ui:historyCursor"
HISTORY_UNAVAILABLE = "HISTORY_UNAVAILABLE"

# The frontend tool the example calls, and the word in a user message that
# makes it do so.
FRONTEND_TOOL_NAME = "confirm"
FRONTEND_TOOL_TRIGGER = "confirm"
TRIGGER_PATTERN = re.compile(rf"\b{FRONTEND_TOOL_TRIGGER}\b", re.IGNORECASE)

router = APIRouter()

# threadId -> messages in conversation order. In-memory, demo only.
THREADS: dict[str, list[Message]] = {}
# One lock per thread id ever seen, never evicted. Fine for a demo; a real
# deployment would rely on its store's own concurrency control.
THREAD_LOCKS: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def get_history_cursor(input_data: RunAgentInput) -> Optional[str]:
    """Read the client's history cursor from forwardedProps, if any."""
    props = input_data.forwarded_props
    if isinstance(props, dict):
        cursor = props.get(HISTORY_CURSOR_KEY)
        if isinstance(cursor, str) and cursor:
            return cursor
    return None


def pending_tool_call_ids(history: list[Message]) -> set[str]:
    """Tool call ids the client may still answer.

    A call is pending while no stored tool message answers it and no user
    message was stored after it. Once the user moved on, the call is
    abandoned: accepting a late result would place it after later user
    turns, and a tool result must directly follow the turn that called it.
    """
    pending: set[str] = set()
    for message in history:
        if isinstance(message, AssistantMessage):
            pending.update(call.id for call in message.tool_calls or [])
        elif isinstance(message, ToolMessage):
            pending.discard(message.tool_call_id)
        elif isinstance(message, UserMessage):
            pending.clear()
    return pending


# Fields a client must not set on a stored message: provider artefacts and
# subagent attribution. Unknown extra fields are dropped as well.
UNTRUSTED_FIELDS = frozenset({"encrypted_value", "subagent_run_id"})


def sanitize(message: Message) -> Message:
    """Copy an accepted client message, keeping only fields a client may set."""
    model = type(message)
    return model.model_validate(
        {
            name: getattr(message, name)
            for name in model.model_fields
            if name not in UNTRUSTED_FIELDS
        }
    )


def accept_client_messages(
    history: list[Message], incoming: list[Message]
) -> list[Message]:
    """Return the incoming messages the server is willing to store.

    Applies the trust rules: ids already stored are ignored (never
    overwritten), only user messages and the first tool result for each
    pending tool call are accepted, everything else is dropped. Tool results
    come before user messages, matching ``ag_ui.server_history`` in the
    Python SDK; within each group the client's order is kept.
    """
    known_ids = {message.id for message in history}
    pending = pending_tool_call_ids(history)
    tool_results: list[Message] = []
    user_messages: list[Message] = []
    for message in incoming:
        if message.id in known_ids:
            continue
        if isinstance(message, UserMessage):
            user_messages.append(sanitize(message))
        elif isinstance(message, ToolMessage) and message.tool_call_id in pending:
            pending.discard(message.tool_call_id)
            tool_results.append(sanitize(message))
        else:
            continue
        known_ids.add(message.id)
    return tool_results + user_messages


def instructions_of(input_data: RunAgentInput) -> list[Message]:
    """The run's system and developer messages: used, never stored."""
    return [
        message
        for message in input_data.messages
        if isinstance(message, (SystemMessage, DeveloperMessage))
    ]


def text_of(message: UserMessage) -> str:
    """The plain text of a user message (string content or text parts)."""
    if isinstance(message.content, str):
        return message.content
    return " ".join(
        getattr(part, "text", "") for part in message.content or []
    )


def should_call_frontend_tool(
    input_data: RunAgentInput, accepted: list[Message]
) -> bool:
    """Whether this run's reply calls the example frontend tool.

    Only when the client declared the tool and the newest accepted user
    message contains the trigger as a whole word.
    """
    if not any(tool.name == FRONTEND_TOOL_NAME for tool in input_data.tools):
        return False
    latest = next(
        (m for m in reversed(accepted) if isinstance(m, UserMessage)), None
    )
    return latest is not None and bool(TRIGGER_PATTERN.search(text_of(latest)))


def build_reply(model_context: list[Message]) -> str:
    """Stand-in for a model call: describe the context the model would get.

    ``model_context`` is this run's instructions followed by the stored
    thread. The counts of user messages and tool results come from the
    store, so a client cannot inflate or rewrite them by resending or forging
    messages. Instructions are counted per request.
    """
    instructions = sum(
        isinstance(m, (SystemMessage, DeveloperMessage)) for m in model_context
    )
    turn = 1 + sum(isinstance(m, AssistantMessage) for m in model_context)
    users = sum(isinstance(m, UserMessage) for m in model_context)
    tools = sum(isinstance(m, ToolMessage) for m in model_context)
    return (
        f"Turn {turn}: {users} user messages, {tools} tool results in server "
        f"context; instructions: {instructions}."
    )


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
            # the cursor, ask it to resend instead of guessing. Nothing but
            # RUN_STARTED may precede this error.
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

            # With or without a cursor, the upload goes through the same trust
            # rules, so stored messages win and forged ones are dropped.
            accepted = accept_client_messages(history, input_data.messages)
            context = history + accepted  # the stored thread after this run's input
            # What a real agent sends the model: this run's instructions
            # (used, never stored) followed by the stored thread.
            model_context = instructions_of(input_data) + context

            reply = AssistantMessage(
                id=str(uuid.uuid4()),
                role="assistant",
                content=build_reply(model_context),
            )
            tool_call: Optional[ToolCall] = None
            if should_call_frontend_tool(input_data, accepted):
                tool_call = ToolCall(
                    id=str(uuid.uuid4()),
                    type="function",
                    function=FunctionCall(
                        name=FRONTEND_TOOL_NAME,
                        arguments=json.dumps({"question": "Shall I go ahead?"}),
                    ),
                )
                reply.tool_calls = [tool_call]

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
            if tool_call is not None:
                # The client runs the tool and sends its result next run. The
                # call stays pending in the store until then.
                yield encoder.encode(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=tool_call.id,
                        tool_call_name=tool_call.function.name,
                        parent_message_id=reply.id,
                    )
                )
                yield encoder.encode(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool_call.id,
                        delta=tool_call.function.arguments,
                    )
                )
                yield encoder.encode(
                    ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=tool_call.id,
                    )
                )

            # The snapshot comes from the store as it will be after this run,
            # never from the client's upload. A client that missed earlier
            # output catches up, and every id in it is a valid cursor.
            thread = context + [reply]
            yield encoder.encode(
                MessagesSnapshotEvent(
                    type=EventType.MESSAGES_SNAPSHOT,
                    messages=thread,
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
            THREADS[input_data.thread_id] = thread

    return StreamingResponse(
        event_generator(), media_type=encoder.get_content_type()
    )
