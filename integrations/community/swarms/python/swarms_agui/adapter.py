"""AG-UI adapter for Swarms agents."""
import asyncio
import copy
import uuid
from collections.abc import AsyncIterator, Sequence
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from swarms import Agent

from ag_ui.core import (
    EventType,
    Message,
    MessagesSnapshotEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from ag_ui.core.types import AssistantMessage
from ag_ui.encoder import EventEncoder


def _role_label(agent: Agent, role: str) -> str:
    """Map an AG-UI message role to the label Swarms uses in its conversation.

    Swarms flattens its short-term memory into a single prompt string
    (``Conversation.return_history_as_string``) before sending it to the model,
    so these labels are simply the turn authors the model reads. Using the
    agent's own ``user_name``/``agent_name`` keeps replayed history consistent
    with the turns Swarms writes itself.
    """
    if role == "user":
        return getattr(agent, "user_name", "User")
    if role == "assistant":
        return getattr(agent, "agent_name", "Assistant")
    if role == "system":
        return "System"
    if role == "tool":
        return "Tool"
    return role.capitalize()


def _rebuild_memory(
    agent: Agent,
    baseline: Any,
    messages: Sequence[Message],
) -> str:
    """Reset the agent's memory to *baseline* and replay *messages* into it.

    The AG-UI client is the source of truth for conversation history and the
    agent instance is shared across every request, so on each turn we restore
    the agent's pristine baseline (system prompt and anything it seeded at
    construction) and replay the incoming history. The trailing user message is
    returned as the task to run rather than seeded, because ``agent.run`` appends
    the task to memory itself — seeding it too would duplicate the turn.

    Returns the task string for ``agent.run``.
    """
    if baseline is not None:
        agent.short_memory.clear()
        agent.short_memory.batch_add(copy.deepcopy(baseline))

    # The task is the most recent user message; everything before it is context.
    last_user_idx = next(
        (i for i in range(len(messages) - 1, -1, -1) if messages[i].role == "user"),
        None,
    )
    if last_user_idx is None:
        history, task = messages, ""
    else:
        history = messages[:last_user_idx]
        task = messages[last_user_idx].content or ""

    if baseline is not None:
        for message in history:
            content = getattr(message, "content", None)
            if not content:
                continue
            agent.short_memory.add(
                role=_role_label(agent, message.role),
                content=content,
            )

    return task


def _capture_baseline(agent: Agent) -> Any:
    """Snapshot the agent's freshly constructed memory so it can be restored.

    Returns ``None`` if the agent does not expose a Swarms-style
    ``short_memory`` (e.g. a custom stub), in which case history replay is
    skipped and only the latest user message is forwarded.
    """
    short_memory = getattr(agent, "short_memory", None)
    if short_memory is None:
        return None
    to_dict = getattr(short_memory, "to_dict", None)
    if not callable(to_dict):
        return None
    try:
        return copy.deepcopy(to_dict())
    except Exception:  # pylint: disable=broad-exception-caught
        return None


async def _event_stream(
    agent: Agent,
    body: RunAgentInput,
    encoder: EventEncoder,
    baseline: Any,
    lock: asyncio.Lock,
) -> AsyncIterator[str]:
    run_id = body.run_id or str(uuid.uuid4())
    thread_id = body.thread_id or str(uuid.uuid4())
    message_id = str(uuid.uuid4())

    yield encoder.encode(
        RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=thread_id,
            run_id=run_id,
        )
    )

    # Rebuilding the shared agent's memory and running it must not interleave
    # with another in-flight request, so the whole reset->seed->run section is
    # serialized per agent. ``agent.run`` is also blocking (it drives the model),
    # so it is offloaded to a worker thread to keep the event loop responsive.
    # We wait for the run to succeed *before* opening the text message, so a
    # failure surfaces as a clean RUN_ERROR rather than leaving an unterminated
    # TEXT_MESSAGE_* sequence on the wire.
    async with lock:
        try:
            task = _rebuild_memory(agent, baseline, body.messages)
            result = await asyncio.to_thread(agent.run, task)
        except Exception as exc:  # pylint: disable=broad-exception-caught
            yield encoder.encode(
                RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=str(exc),
                    code="SWARMS_RUN_ERROR",
                )
            )
            return

    response = result if isinstance(result, str) else str(result)

    yield encoder.encode(
        TextMessageStartEvent(
            type=EventType.TEXT_MESSAGE_START,
            message_id=message_id,
            role="assistant",
        )
    )
    yield encoder.encode(
        TextMessageContentEvent(
            type=EventType.TEXT_MESSAGE_CONTENT,
            message_id=message_id,
            delta=response,
        )
    )
    yield encoder.encode(
        TextMessageEndEvent(
            type=EventType.TEXT_MESSAGE_END,
            message_id=message_id,
        )
    )

    snapshot: list[Message] = list(body.messages) + [
        AssistantMessage(
            id=message_id,
            role="assistant",
            content=response,
        )
    ]
    yield encoder.encode(
        MessagesSnapshotEvent(
            type=EventType.MESSAGES_SNAPSHOT,
            messages=snapshot,
        )
    )
    yield encoder.encode(
        RunFinishedEvent(
            type=EventType.RUN_FINISHED,
            thread_id=thread_id,
            run_id=run_id,
        )
    )


def add_swarms_fastapi_endpoint(
    app: FastAPI,
    agent: Agent,
    path: str = "/",
) -> None:
    """Register a POST endpoint on *app* that wraps *agent* as an AG-UI SSE stream.

    The full AG-UI conversation history is replayed into the agent on every
    request, so the agent has multi-turn context. The agent's memory is reset to
    the state captured here (its system prompt and any construction-time seeding)
    before each request, keeping the endpoint stateless and the client the source
    of truth for history.
    """
    baseline = _capture_baseline(agent)
    lock = asyncio.Lock()

    @app.post(path)
    async def swarms_endpoint(body: RunAgentInput, request: Request):
        encoder = EventEncoder(accept=request.headers.get("accept"))
        return StreamingResponse(
            _event_stream(agent, body, encoder, baseline, lock),
            media_type=encoder.get_content_type(),
        )
