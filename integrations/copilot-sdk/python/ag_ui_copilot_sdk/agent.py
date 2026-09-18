"""AG-UI agent backed by a native GitHub Copilot SDK session."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import AsyncIterator, Callable
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from ag_ui.core import (
    BaseEvent,
    CustomEvent,
    Interrupt,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunFinishedInterruptOutcome,
    RunStartedEvent,
    StateSnapshotEvent,
    ToolMessage,
)
from copilot.rpc import ExternalToolTextResultForLlm, HandlePendingToolCallRequest
from copilot.tools import Tool, ToolInvocation, ToolResult

from .mapper import EventMapper

logger = logging.getLogger(__name__)

#: Native sessions are process-local; a restart drops suspended tool calls.
MAX_THREADS = 32
#: Quiet period after a pending tool request before handing off to the browser.
HANDOFF_DELAY = 0.05


@dataclass
class ToolContext:
    """What a server-side tool handler gets besides its arguments."""

    invocation: ToolInvocation
    #: Shared state the client sent with the current run.
    state: Any
    #: Emit an AG-UI event into the current run, ordered with the native stream.
    emit: Callable[[BaseEvent], None]
    #: Replace the shared state (a STATE_SNAPSHOT).
    set_state: Callable[[Any], None]


@dataclass
class AGUITool:
    """A server-side tool. Omit ``handler`` to make the call pause for the browser."""

    name: str
    description: str = ""
    parameters: dict[str, Any] | None = None
    handler: Callable[[Any, ToolContext], Any] | None = None
    skip_permission: bool = False


@dataclass
class _Pending:
    request_id: str
    tool_name: str
    args: Any
    subagent_run_id: str | None = None


@dataclass
class _Thread:
    mapper: EventMapper = field(default_factory=EventMapper)
    session: Any = None
    #: AG-UI toolCallId -> the suspended external tool call this process still holds.
    pending: dict[str, _Pending] = field(default_factory=dict)
    sent_user_ids: set[str] = field(default_factory=set)
    #: Native events and, tagged as ``{"type": "agui", "event": ...}``, handler-emitted ones.
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    state: Any = None
    busy: bool = False


def _byok_provider() -> dict[str, Any]:
    """Route inference at an OpenAI-compatible endpoint when one is configured."""
    base_url = os.getenv("OPENAI_BASE_URL")
    if not base_url:
        return {}
    return {
        "provider": {
            "type": "openai",
            "base_url": base_url,
            "api_key": os.getenv("OPENAI_API_KEY", ""),
        },
        "model": os.getenv("OPENAI_CHAT_MODEL_ID", "gpt-4o"),
    }


def _user_input(content: Any) -> tuple[str, list[dict[str, Any]]]:
    """Unsupported media retains a text placeholder rather than disappearing silently."""
    if isinstance(content, str):
        return content, []
    out: list[dict[str, Any]] = []
    text: list[str] = []
    warned = False
    for part in content if isinstance(content, list) else []:
        if part.type == "text":
            text.append(part.text)
            continue
        source = getattr(part, "source", None)
        data = part.data if part.type == "binary" else getattr(source, "value", None)
        mime = part.mime_type if part.type == "binary" else getattr(source, "mime_type", None)
        if data and mime and getattr(source, "type", "data") == "data":
            out.append(
                {"type": "blob", "data": re.sub(r"^data:[^,]*,", "", data), "mimeType": mime}
            )
        else:
            text.append(f"[Unsupported {part.type} content]")
            if not warned:
                logger.warning(
                    "Unsupported media: using text placeholders; only inline data is forwarded"
                )
                warned = True
    return "\n".join(text), out


def _parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except ValueError:
        return text


def _build_prompt(input_data: RunAgentInput, user_content: str) -> str:
    """State and context belong in the prompt preamble, like the sibling SDK integrations."""
    parts: list[str] = []
    if input_data.context:
        parts.append("## Context from the application")
        parts.extend(f"- {entry.description}: {entry.value}" for entry in input_data.context)
        parts.append("")
    if input_data.state:
        parts.append("## Current shared state")
        parts.append(f"```json\n{json.dumps(input_data.state, indent=2)}\n```")
        parts.append("")
    parts.append(user_content)
    return "\n".join(parts)


class CopilotAgent:
    """Serves one Copilot SDK session per AG-UI thread.

    Frontend tools are registered without a handler, so the runtime suspends the
    call and reports it as ``external_tool.requested``. The run then finishes, the
    browser executes the tool, and the next ``RunAgentInput`` carries a
    ``role: "tool"`` message that resolves the *original* RPC through
    ``handle_pending_tool_call`` — the result is never re-prompted as user text.
    """

    def __init__(
        self,
        client: Any,
        *,
        name: str = "copilot",
        model: str = "gpt-5.4-mini",
        instructions: str | None = None,
        tools: list[AGUITool] | None = None,
        session_options: dict[str, Any] | None = None,
        predict_state: list[dict[str, str]] | None = None,
        interrupts: dict[str, Callable[[Any, Any], Any]] | None = None,
        run_timeout: float = 120.0,
        max_pending_tools: int = 32,
    ):
        """
        ``predict_state`` entries (``{"state_key", "tool", "tool_argument"}``) are
        emitted as a ``PredictState`` CUSTOM event at the start of every run.

        ``interrupts`` names handler-less tools that pause the run with an interrupt
        outcome instead of a plain finish; the function maps the client's resume
        payload to the result the model sees when the paused call continues.
        """
        self.client = client
        self.name = name
        self.model = model
        self.instructions = instructions
        self.tools = tools or []
        self.session_options = session_options or {}
        self.predict_state = predict_state
        self.interrupts = interrupts or {}
        self.run_timeout = run_timeout
        self.max_pending_tools = max_pending_tools
        self._threads: dict[str, _Thread] = {}

    async def close(self) -> None:
        for thread_id in list(self._threads):
            await self._dispose(thread_id)

    async def _dispose(self, thread_id: str) -> None:
        thread = self._threads.pop(thread_id, None)
        if thread is None or thread.session is None:
            return
        for closer in (thread.session.abort, thread.session.disconnect):
            try:
                await asyncio.wait_for(closer(), 5)
            except Exception:  # noqa: BLE001, S110 -- cleanup is best effort.
                pass

    def _bind(self, thread: _Thread, tool: AGUITool) -> Tool:
        """Server-side handlers get the AG-UI run context; handler-less tools pause."""
        if tool.handler is None:
            return Tool(
                tool.name, tool.description, parameters=tool.parameters, skip_permission=True
            )

        def emit(event: BaseEvent) -> None:
            thread.queue.put_nowait({"type": "agui", "event": event})

        def set_state(snapshot: Any) -> None:
            thread.state = deepcopy(snapshot)
            emit(StateSnapshotEvent(snapshot=deepcopy(thread.state)))

        async def handler(invocation: ToolInvocation) -> ToolResult:
            context = ToolContext(
                invocation=invocation,
                state=thread.state,
                emit=emit,
                set_state=set_state,
            )
            result = tool.handler(invocation.arguments or {}, context)
            if asyncio.iscoroutine(result):
                result = await result
            if isinstance(result, ToolResult):
                return result
            return ToolResult(
                text_result_for_llm=result if isinstance(result, str) else json.dumps(result)
            )

        return Tool(
            tool.name,
            tool.description,
            handler=handler,
            parameters=tool.parameters,
            skip_permission=tool.skip_permission,
        )

    async def _create_session(self, thread: _Thread, input_data: RunAgentInput) -> Any:
        # Frontend tools are declared without a handler: that is what makes the
        # runtime suspend the call instead of executing it.
        tools = [self._bind(thread, tool) for tool in self.tools] + [
            Tool(
                name=tool.name,
                description=tool.description,
                parameters=tool.parameters,
                skip_permission=True,
            )
            for tool in input_data.tools
        ]
        # Only the tools registered here, plus the `task` built-in when custom
        # agents exist (it is what dispatches them). Required by mode="empty".
        available = ["custom:*"] + (
            ["builtin:task"] if self.session_options.get("custom_agents") else []
        )
        options: dict[str, Any] = {
            "model": self.model,
            "streaming": True,
            "tools": tools,
            "available_tools": available,
            "on_event": lambda event: thread.queue.put_nowait(event.to_dict()),
        }
        if self.instructions:
            options["system_message"] = {"mode": "append", "content": self.instructions}
        options.update(_byok_provider())
        options.update(self.session_options)
        return await self.client.create_session(**options)

    async def _resolve_pending(self, thread: _Thread, message: Any) -> None:
        call = thread.pending.pop(message.tool_call_id)
        resume = self.interrupts.get(call.tool_name)
        # An interrupt's answer arrives as the tool result; the mapper decides what the model reads.
        content: Any = (
            resume(_parse_json(message.content), call.args)
            if resume and not message.error
            else message.content
        )
        # An errored browser tool must reach the model as a failure, not a success.
        result: Any = (
            ExternalToolTextResultForLlm(
                text_result_for_llm=message.content or message.error,
                result_type="failure",
                error=message.error,
            )
            if getattr(message, "error", None)
            else content
            if isinstance(content, str)
            else json.dumps(content)
        )
        response = await thread.session.rpc.tools.handle_pending_tool_call(
            HandlePendingToolCallRequest(request_id=call.request_id, result=result)
        )
        if not response.success:
            raise RuntimeError("Native pending tool call could not be resolved")

    def _interrupt_outcome(self, thread: _Thread) -> RunFinishedInterruptOutcome | None:
        """Suspended interrupt tools turn the finish into an outcome the client must resume."""
        interrupts = [
            Interrupt(
                id=call_id,
                reason="tool_call",
                tool_call_id=call_id,
                message=f"Paused in {call.tool_name}",
                metadata={"reason": call.args},
                subagent_run_id=call.subagent_run_id,
            )
            for call_id, call in thread.pending.items()
            if call.tool_name in self.interrupts
        ]
        return RunFinishedInterruptOutcome(interrupts=interrupts) if interrupts else None

    async def _next_event(self, thread: _Thread, deadline: float) -> dict[str, Any] | None:
        """Next native event, or ``None`` once the stream goes quiet or the run expires."""
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            return None
        wait = min(HANDOFF_DELAY, remaining) if thread.pending else remaining
        try:
            return await asyncio.wait_for(thread.queue.get(), wait)
        except TimeoutError:
            return None

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[BaseEvent]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.run_timeout

        thread = self._threads.get(input_data.thread_id)
        if thread is None:
            if len(self._threads) >= MAX_THREADS:
                await self._dispose(next(iter(self._threads)))
            thread = self._threads[input_data.thread_id] = _Thread()
        if thread.busy:
            raise RuntimeError("Thread already has an active run")
        thread.busy = True
        thread.state = input_data.state

        yield RunStartedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id)
        for event in thread.mapper.resume():
            yield event
        if self.predict_state:
            yield CustomEvent(name="PredictState", value=self.predict_state)

        # Only results resolving a call this process still holds are actionable;
        # AG-UI clients replay the whole transcript on every run.
        results = [
            message
            for message in input_data.messages
            if message.role == "tool" and message.tool_call_id in thread.pending
        ]
        users = [message for message in input_data.messages if message.role == "user"]
        last_user = users[-1] if users else None
        new_user = (
            _user_input(last_user.content)
            if last_user is not None and last_user.id not in thread.sent_user_ids
            else None
        )

        failed = False
        try:
            for entry in input_data.resume or []:
                if entry.interrupt_id not in thread.pending:
                    raise RuntimeError("Unknown or expired interrupt")
                if not any(r.tool_call_id == entry.interrupt_id for r in results):
                    results.append(
                        ToolMessage(
                            id=f"resume:{entry.interrupt_id}",
                            tool_call_id=entry.interrupt_id,
                            content=json.dumps(
                                {"cancelled": True}
                                if entry.status == "cancelled"
                                else entry.payload
                            ),
                        )
                    )
            if thread.session is None and any(m.role == "tool" for m in input_data.messages):
                raise RuntimeError("Pending tool session was lost; start a new thread")
            if thread.session is None:
                thread.session = await asyncio.wait_for(
                    self._create_session(thread, input_data), self.run_timeout
                )

            if results:
                await asyncio.wait_for(
                    asyncio.gather(*(self._resolve_pending(thread, r) for r in results)),
                    max(deadline - loop.time(), 0),
                )
            elif new_user:
                thread.sent_user_ids.add(last_user.id)
                text, attachments = new_user
                await asyncio.wait_for(
                    thread.session.send(
                        _build_prompt(
                            input_data,
                            text or ("Describe the attached media." if attachments else ""),
                        ),
                        **({"attachments": attachments} if attachments else {}),
                    ),
                    max(deadline - loop.time(), 0),
                )
            else:
                # Nothing new to do: a replayed transcript with no unresolved work.
                for event in thread.mapper.finish():
                    yield event
                for event in thread.mapper.suspend():
                    yield event
                yield RunFinishedEvent(
                    thread_id=input_data.thread_id,
                    run_id=input_data.run_id,
                    outcome=self._interrupt_outcome(thread),
                )
                return

            # Frontend tools and interrupt tools both suspend until a later run resolves them.
            paused = {tool.name for tool in input_data.tools} | set(self.interrupts)
            while True:
                raw = await self._next_event(thread, deadline)
                if raw is None:
                    # Quiet with suspended tool calls: hand off to the browser.
                    if thread.pending:
                        break
                    raise TimeoutError("Run timed out")
                kind, data = raw["type"], raw.get("data") or {}
                if kind == "agui":
                    yield raw["event"]
                    continue
                if kind == "session.error":
                    raise RuntimeError(data.get("message") or "SDK session failed")
                if kind in ("abort", "agent.interrupted"):
                    raise RuntimeError("Run was interrupted")
                if kind == "external_tool.requested" and data["toolName"] in paused:
                    call_id = data["toolCallId"]
                    if call_id not in thread.pending and (
                        len(thread.pending) >= self.max_pending_tools
                    ):
                        raise RuntimeError("Pending frontend tool limit exceeded")
                    thread.pending[call_id] = _Pending(
                        data["requestId"],
                        data["toolName"],
                        data.get("arguments"),
                        raw.get("agentId"),
                    )
                for event in thread.mapper.map_event(raw):
                    yield event
                if kind == "session.idle" and not raw.get("agentId") and not thread.pending:
                    break

            for event in thread.mapper.finish():
                yield event
            for event in thread.mapper.suspend():
                yield event
            yield RunFinishedEvent(
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
                outcome=self._interrupt_outcome(thread),
            )
        except (GeneratorExit, asyncio.CancelledError):
            failed = True
            raise
        except Exception as exc:  # noqa: BLE001 -- surfaced to the client as RUN_ERROR.
            failed = True
            for event in thread.mapper.finish():
                yield event
            yield RunErrorEvent(message=str(exc) or type(exc).__name__, code="COPILOT_SDK_ERROR")
        finally:
            thread.busy = False
            # A failed run leaves the native session in an unknown state; drop it
            # rather than leaking the thread and its suspended RPCs.
            if failed:
                await self._dispose(input_data.thread_id)
