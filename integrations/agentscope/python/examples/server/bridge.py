"""AG-UI request boundary for AgentScope's native protocol middleware."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, aclosing

from ag_ui.core import (
    PROTOCOL_VERSION,
    ContentPart,
    RunAgentInput,
    RunErrorEvent,
    RunStartedEvent,
)
from agentscope.agent import Agent
from agentscope.app.middleware import AGUIProtocolMiddleware
from agentscope.event import (
    ReplyEndEvent,
    ReplyStartEvent,
    RequireExternalExecutionEvent,
    RequireUserConfirmEvent,
)
from agentscope.message import (
    AssistantMsg,
    Msg,
    SystemMsg,
    TextBlock,
    ToolCallBlock,
    ToolCallState,
    ToolResultBlock,
    ToolResultState,
    UserMsg,
)
from agentscope.types import ReplyFinishedReason
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)
AgentFactory = Callable[[RunAgentInput], AbstractAsyncContextManager[Agent]]


class RequestScopedAGUIProtocol:
    """Keep the native converter's tool buffers/model name local to a request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await AGUIProtocolMiddleware(self.app)(scope, receive, send)


def _text(content: str | list[ContentPart] | None) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for part in content:
        if part.type != "text":
            raise ValueError(
                "This example supports text messages, not multimodal input"
            )
        parts.append(part.text)
    return "".join(parts)


def history_messages(input_data: RunAgentInput) -> list[Msg]:
    """Replay the supplied history into a new AgentScope instance, once per run."""
    messages: list[Msg] = []
    if input_data.context:
        messages.append(
            SystemMsg(
                name="context",
                content="\n".join(
                    f"{item.description}: {item.value}" for item in input_data.context
                ),
            )
        )
    tool_names: dict[str, str] = {}
    seen_calls: set[str] = set()
    for message in input_data.messages:
        if message.role == "user":
            messages.append(
                UserMsg(name="user", id=message.id, content=_text(message.content))
            )
        elif message.role in ("system", "developer"):
            messages.append(
                SystemMsg(name="system", id=message.id, content=_text(message.content))
            )
        elif message.role == "assistant":
            content: list[TextBlock | ToolCallBlock] = []
            text = _text(message.content)
            if text:
                content.append(TextBlock(text=text))
            for call in message.tool_calls or []:
                if call.id in seen_calls:
                    raise ValueError(
                        "Tool call IDs must be unique within a run's history"
                    )
                seen_calls.add(call.id)
                tool_names[call.id] = call.function.name
                content.append(
                    ToolCallBlock(
                        id=call.id,
                        name=call.function.name,
                        input=call.function.arguments,
                        state=ToolCallState.FINISHED,
                    )
                )
            messages.append(
                AssistantMsg(name="assistant", id=message.id, content=content)
            )
        elif message.role == "tool":
            name = tool_names.pop(message.tool_call_id, None)
            if name is None:
                raise ValueError(
                    "A tool result must follow its matching assistant tool call"
                )
            messages.append(
                AssistantMsg(
                    name="assistant",
                    id=message.id,
                    content=[
                        ToolResultBlock(
                            id=message.tool_call_id,
                            name=name,
                            output=_text(message.content),
                            state=ToolResultState.SUCCESS,
                        )
                    ],
                )
            )
        else:
            raise ValueError(f"Unsupported input message role: {message.role}")
    if not input_data.messages:
        raise ValueError("At least one message is required")
    if tool_names:
        raise ValueError(
            "Tool calls in the supplied history must have matching results"
        )
    return messages


def _sse(event: BaseModel) -> str:
    return f"data: {event.model_dump_json(by_alias=True, exclude_none=True)}\n\n"


async def run_stream(
    input_data: RunAgentInput,
    factory: AgentFactory,
    messages: list[Msg],
) -> AsyncIterator[str]:
    """Emit native events; AgentScope's middleware owns event conversion."""
    yield _sse(
        RunStartedEvent(
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
            protocol_version=PROTOCOL_VERSION,
        )
    )
    try:
        async with factory(input_data) as agent:
            # AgentScope's `inputs` accepts new user/assistant text only. Restore
            # completed tool exchanges and system messages through its public state.
            agent.state.context.extend(messages)
            terminal: ReplyEndEvent | RunErrorEvent | None = None
            async with aclosing(agent.reply_stream(inputs=None)) as events:
                async for event in events:
                    task = asyncio.current_task()
                    if task is not None and task.cancelling():
                        raise asyncio.CancelledError
                    if isinstance(event, ReplyStartEvent):
                        continue
                    if isinstance(
                        event, (RequireExternalExecutionEvent, RequireUserConfirmEvent)
                    ):
                        terminal = RunErrorEvent(
                            message="This example does not implement client-tool or approval continuation",
                            code="unsupported_interaction",
                        )
                        break
                    if isinstance(event, ReplyEndEvent):
                        if event.finished_reason in (
                            ReplyFinishedReason.INTERRUPTED,
                            ReplyFinishedReason.ERROR,
                        ):
                            terminal = RunErrorEvent(
                                message="The AgentScope reply was interrupted or failed",
                                code="reply_failed",
                            )
                            break
                        terminal = event.model_copy(
                            update={
                                "session_id": input_data.thread_id,
                                "reply_id": input_data.run_id,
                            }
                        )
                        break
                    yield _sse(event)
        # Complete resource cleanup before emitting the one terminal event.
        if terminal is None:
            yield _sse(
                RunErrorEvent(
                    message="The AgentScope stream ended without a reply end",
                    code="incomplete_stream",
                )
            )
        else:
            yield _sse(terminal)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("AgentScope example run failed")
        yield _sse(
            RunErrorEvent(
                message="The AgentScope run failed; check the server logs",
                code="agent_error",
            )
        )


def create_agent_app(factory: AgentFactory) -> FastAPI:
    """Expose a managed Agent factory as a stateless AG-UI HTTP endpoint."""
    app = FastAPI()
    app.add_middleware(RequestScopedAGUIProtocol)

    @app.post("/")
    async def run(input_data: RunAgentInput) -> StreamingResponse:
        try:
            messages = history_messages(input_data)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return StreamingResponse(
            run_stream(input_data, factory, messages),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    return app
