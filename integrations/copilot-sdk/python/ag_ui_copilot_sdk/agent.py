"""AG-UI agent backed by a native GitHub Copilot SDK session."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from ag_ui.core import (
    BaseEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)
from copilot.rpc import HandlePendingToolCallRequest
from copilot.tools import Tool

from .mapper import EventMapper

#: Native sessions are process-local; a restart drops suspended tool calls.
MAX_THREADS = 32
#: Quiet period after a pending tool request before handing off to the browser.
HANDOFF_DELAY = 0.05


@dataclass
class _Thread:
    mapper: EventMapper = field(default_factory=EventMapper)
    session: Any = None
    #: AG-UI toolCallId -> native requestId of the suspended external tool call.
    pending: dict[str, str] = field(default_factory=dict)
    sent_user_ids: set[str] = field(default_factory=set)
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
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


def _text_of(content: Any) -> str:
    """This integration prompts with text; non-text parts are dropped, not mangled."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") if isinstance(part, dict) else getattr(part, "text", "")
            for part in content
            if (part.get("type") if isinstance(part, dict) else getattr(part, "type", None))
            == "text"
        )
    return ""


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
        tools: list[Tool] | None = None,
        session_options: dict[str, Any] | None = None,
        run_timeout: float = 120.0,
        max_pending_tools: int = 32,
    ):
        self.client = client
        self.name = name
        self.model = model
        self.instructions = instructions
        self.tools = tools or []
        self.session_options = session_options or {}
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

    async def _create_session(self, thread: _Thread, input_data: RunAgentInput) -> Any:
        # Frontend tools are declared without a handler: that is what makes the
        # runtime suspend the call instead of executing it.
        tools = list(self.tools) + [
            Tool(
                name=tool.name,
                description=tool.description,
                parameters=tool.parameters,
                skip_permission=True,
            )
            for tool in input_data.tools
        ]
        options: dict[str, Any] = {
            "model": self.model,
            "streaming": True,
            "tools": tools,
            # Only the tools registered here; no built-ins. Required by mode="empty".
            "available_tools": ["custom:*"],
            "on_event": lambda event: thread.queue.put_nowait(event.to_dict()),
        }
        if self.instructions:
            options["system_message"] = {"mode": "append", "content": self.instructions}
        options.update(_byok_provider())
        options.update(self.session_options)
        return await self.client.create_session(**options)

    async def _resolve_pending(self, thread: _Thread, message: Any) -> None:
        request_id = thread.pending.pop(message.tool_call_id)
        # An errored browser tool must reach the model as a failure, not a success.
        result: Any = (
            {
                "textResultForLlm": message.content,
                "resultType": "failure",
                "error": message.error,
            }
            if getattr(message, "error", None)
            else message.content
        )
        response = await thread.session.rpc.tools.handle_pending_tool_call(
            HandlePendingToolCallRequest(request_id=request_id, result=result)
        )
        if not response.success:
            raise RuntimeError("Native pending tool call could not be resolved")

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

        yield RunStartedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id)

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
            _text_of(last_user.content)
            if last_user is not None and last_user.id not in thread.sent_user_ids
            else None
        )

        failed = False
        try:
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
                await asyncio.wait_for(
                    thread.session.send(_build_prompt(input_data, new_user)),
                    max(deadline - loop.time(), 0),
                )
            else:
                # Nothing new to do: a replayed transcript with no unresolved work.
                for event in thread.mapper.finish():
                    yield event
                yield RunFinishedEvent(
                    thread_id=input_data.thread_id, run_id=input_data.run_id
                )
                return

            frontend_names = {tool.name for tool in input_data.tools}
            while True:
                raw = await self._next_event(thread, deadline)
                if raw is None:
                    # Quiet with suspended tool calls: hand off to the browser.
                    if thread.pending:
                        break
                    raise TimeoutError("Run timed out")
                kind, data = raw["type"], raw.get("data") or {}
                if kind == "session.error":
                    raise RuntimeError(data.get("message") or "SDK session failed")
                if kind in ("abort", "agent.interrupted"):
                    raise RuntimeError("Run was interrupted")
                if kind == "external_tool.requested" and data["toolName"] in frontend_names:
                    call_id = data["toolCallId"]
                    if call_id not in thread.pending and (
                        len(thread.pending) >= self.max_pending_tools
                    ):
                        raise RuntimeError("Pending frontend tool limit exceeded")
                    thread.pending[call_id] = data["requestId"]
                for event in thread.mapper.map_event(raw):
                    yield event
                if kind == "session.idle" and not thread.pending:
                    break

            for event in thread.mapper.finish():
                yield event
            yield RunFinishedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id)
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
