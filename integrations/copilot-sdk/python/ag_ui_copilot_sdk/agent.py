"""Async-generator adapter with bounded, in-process ownership of SDK sessions."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import re
import time
from collections.abc import AsyncIterator, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from ag_ui.core import (
    ActivitySnapshotEvent,
    BaseEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    ToolCallResultEvent,
)
from copilot import CopilotClient
from copilot.rpc import HandlePendingToolCallRequest, PermissionDecisionUserNotAvailable
from copilot.tools import Tool

from .mapper import EventMapper


class SessionClient(Protocol):
    async def create_session(self, *, on_event: Callable[[Any], None], **options: Any) -> Any: ...


class InputError(ValueError):
    """Invalid or unsupported AG-UI input."""

    code = "INVALID_INPUT"

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.code = code or self.code


class ThreadConflict(InputError):
    """Busy, expired, or mismatched continuation."""

    code = "THREAD_CONFLICT"


def validate_input(
    value: RunAgentInput | Mapping[str, Any], *, max_bytes: int = 1_048_576
) -> RunAgentInput:
    if isinstance(value, RunAgentInput):
        value = value.model_dump(by_alias=True, exclude_none=True)
    try:
        encoded = json.dumps(value, allow_nan=False)
        if len(encoded.encode()) > max_bytes:
            raise InputError("Request exceeds size limit")
        result = RunAgentInput.model_validate(value, strict=True)
    except (TypeError, ValueError) as exc:
        raise InputError("Invalid RunAgentInput") from exc
    if (
        not result.thread_id
        or len(result.thread_id) > 200
        or not result.run_id
        or len(result.run_id) > 200
    ):
        raise InputError("threadId and runId must contain 1-200 characters")
    if len(result.messages) > 1000 or len(result.tools) > 64:
        raise InputError("Message/tool count limit exceeded")
    names = [tool.name for tool in result.tools]
    if len(set(names)) != len(names) or any(
        not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name) for name in names
    ):
        raise InputError("Tool names must be unique identifiers")
    if any(
        not isinstance(tool.parameters, dict) or tool.parameters.get("type") != "object"
        for tool in result.tools
    ):
        raise InputError("Tool parameters must be an object JSON schema")
    ids = [message.id for message in result.messages]
    if len(ids) != len(set(ids)) or any(not identity or len(identity) > 200 for identity in ids):
        raise InputError("Message IDs must be nonempty and unique")
    return result


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


async def _cancel_tasks(tasks: Iterable[asyncio.Task]) -> None:
    tasks = tuple(tasks)
    for task in tasks:
        if not task.done() and not task.cancelling():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


@dataclass
class ThreadContext:
    """Application tool factory context; state and emit are application-owned."""

    thread_id: str
    queue: asyncio.Queue
    state: Any = None
    handoff_state: Any = None
    session: Any = None
    mapper: EventMapper = field(default_factory=EventMapper)
    pending: dict[str, str] = field(default_factory=dict)
    request_owners: dict[str, str] = field(default_factory=dict)
    resolved: dict[str, str] = field(default_factory=dict)
    user_messages: dict[str, str] = field(default_factory=dict)
    expected_frontend: set[str] = field(default_factory=set)
    frontend_names: set[str] = field(default_factory=set)
    tool_signature: str = ""
    active: bool = False
    closed: bool = False
    overflow: bool = False
    updated: float = field(default_factory=time.monotonic)
    owner_task: asyncio.Task | None = None
    cleanup_task: asyncio.Task | None = field(default=None, init=False, repr=False)
    rpc_tasks: set[asyncio.Task] = field(default_factory=set, init=False, repr=False)
    epoch: int = field(default=0, init=False)
    unsubscribe: Callable[[], None] | None = None
    max_event_bytes: int = 262_144

    def emit(self, event: BaseEvent | Mapping[str, Any]) -> None:
        if self.closed or self.overflow:
            return
        try:
            payload = (
                event.model_dump(mode="json", by_alias=True, exclude_none=True)
                if isinstance(event, BaseEvent)
                else event
            )
            if len(json.dumps(payload, allow_nan=False).encode()) > self.max_event_bytes:
                raise asyncio.QueueFull
            self.queue.put_nowait(
                event if isinstance(event, BaseEvent) else {**event, "_epoch": self.epoch}
            )
        except (asyncio.QueueFull, ValueError, TypeError):
            self.overflow = True
            # Make room for a wakeup; the consumer observes overflow before processing it.
            if self.queue.full():
                self.queue.get_nowait()
            self.queue.put_nowait({"type": "session.error", "data": {}, "_epoch": self.epoch})


class CopilotAgent:
    """One live session/thread. Caller owns client.start(); close() owns retained sessions.

    Frontend results resolve the original typed pending RPC, never ``session.send``.
    The experimental 1.0.14 RPC is isolated in ``_resolve``.
    """

    def __init__(
        self,
        client: CopilotClient | SessionClient,
        *,
        model: str = "auto",
        tools_factory: Callable[[ThreadContext], list[Tool]] | None = None,
        state_validator: Callable[[Any, Any], Any] | None = None,
        instructions: str = "You are a helpful assistant. Use declared tools when requested.",
        max_threads: int = 32,
        max_queue: int = 256,
        max_output_chars: int = 65_536,
        max_session_items: int = 4096,
        max_events: int = 20_000,
        max_request_bytes: int = 1_048_576,
        max_event_bytes: int = 262_144,
        idle_ttl: float = 900,
        run_timeout: float = 180,
        handoff_delay: float = 0.1,
    ):
        if (
            min(
                max_threads,
                max_queue,
                max_output_chars,
                max_session_items,
                max_events,
                max_request_bytes,
                max_event_bytes,
                idle_ttl,
                run_timeout,
                handoff_delay,
            )
            <= 0
        ):
            raise ValueError("Limits must be positive")
        self.client = client
        self.model = model
        self.tools_factory = tools_factory
        self.state_validator = state_validator
        self.instructions = instructions
        self.max_threads = max_threads
        self.max_queue = max_queue
        self.max_output_chars = max_output_chars
        self.max_session_items = max_session_items
        self.max_events = max_events
        self.max_request_bytes = max_request_bytes
        self.max_event_bytes = max_event_bytes
        self.idle_ttl = idle_ttl
        self.run_timeout = run_timeout
        self.handoff_delay = handoff_delay
        self.threads: dict[str, ThreadContext] = {}
        self._reaper: asyncio.Task | None = None
        self._closed = False

    async def _reap(self) -> None:
        while True:
            await asyncio.sleep(min(self.idle_ttl, 30))
            now = time.monotonic()
            for thread in list(self.threads.values()):
                abandoned = thread.owner_task is not None and thread.owner_task.done()
                if abandoned or (not thread.active and now - thread.updated >= self.idle_ttl):
                    await self._drop(thread)

    async def _drop(self, thread: ThreadContext) -> None:
        if thread.cleanup_task is None:
            thread.closed = True
            thread.cleanup_task = asyncio.create_task(self._close_thread(thread))
        try:
            await asyncio.shield(thread.cleanup_task)
        except asyncio.CancelledError:
            await asyncio.shield(thread.cleanup_task)
            raise

    async def _close_thread(self, thread: ThreadContext) -> None:
        await _cancel_tasks(thread.rpc_tasks)
        if thread.unsubscribe:
            thread.unsubscribe()
        if thread.session:
            try:
                await asyncio.wait_for(thread.session.abort(), 5)
            except Exception:  # noqa: BLE001 -- cleanup must attempt disconnect even after abort fails.
                logging.getLogger(__name__).warning("SDK abort failed during cleanup")
            try:
                await asyncio.wait_for(thread.session.disconnect(), 5)
            except Exception:  # noqa: BLE001 -- best effort; client owner must stop its transport.
                logging.getLogger(__name__).warning("SDK disconnect failed during cleanup")
        thread.pending.clear()
        while not thread.queue.empty():
            thread.queue.get_nowait()
        if self.threads.get(thread.thread_id) is thread:
            del self.threads[thread.thread_id]

    async def close(self) -> None:
        self._closed = True
        if self._reaper:
            self._reaper.cancel()
            await asyncio.gather(self._reaper, return_exceptions=True)
        threads = list(self.threads.values())
        owners = {
            t.owner_task
            for t in threads
            if t.owner_task and t.owner_task is not asyncio.current_task()
        }
        for task in owners:
            task.cancel()
        await asyncio.gather(*(self._drop(thread) for thread in threads))
        if owners:
            await asyncio.gather(*owners, return_exceptions=True)

    async def cancel(self, thread_id: str) -> None:
        thread = self.threads.get(thread_id)
        if thread:
            if thread.owner_task and thread.owner_task is not asyncio.current_task():
                thread.owner_task.cancel()
            await self._drop(thread)

    def _reserve(self, request: RunAgentInput) -> ThreadContext:
        if self._closed:
            raise ThreadConflict("Adapter closed")
        thread = self.threads.get(request.thread_id)
        if thread and thread.closed:
            raise ThreadConflict("Thread cleanup is still in progress")
        if thread and thread.active:
            raise ThreadConflict("Thread already has an active request")
        if thread is None:
            if len(self.threads) >= self.max_threads:
                raise ThreadConflict("Warm session capacity reached")
            thread = ThreadContext(
                thread_id=request.thread_id,
                queue=asyncio.Queue(maxsize=self.max_queue),
                mapper=EventMapper(
                    max_output_chars=self.max_output_chars, max_items=self.max_session_items,
                    max_events=self.max_events,
                ),
                max_event_bytes=self.max_event_bytes,
            )
            self.threads[request.thread_id] = thread
        thread.active = True
        thread.owner_task = asyncio.current_task()
        if self._reaper is None:
            self._reaper = asyncio.create_task(self._reap())
        return thread

    async def _create(self, thread: ThreadContext, request: RunAgentInput) -> None:
        tools = self.tools_factory(thread) if self.tools_factory else []
        if thread.frontend_names.intersection(tool.name for tool in tools):
            raise InputError("Frontend tool shadows an application tool")
        tools += [
            Tool(
                name=tool.name,
                description=tool.description,
                parameters=tool.parameters,
                skip_permission=True,
            )
            for tool in request.tools
        ]

        def on_event(event: Any) -> None:
            raw = event.to_dict()
            kind = raw["type"]
            if kind in {
                "assistant.message",
                "assistant.message_delta",
                "assistant.reasoning",
                "assistant.reasoning_delta",
                "assistant.tool_call_delta",
                "assistant.turn_end",
                "external_tool.requested",
                "session.idle",
                "session.error",
                "abort",
                "agent.interrupted",
                "subagent.started",
                "subagent.completed",
                "subagent.failed",
            } or kind.startswith("tool.execution_"):
                thread.emit(raw)

        thread.session = await self.client.create_session(
            model=self.model,
            streaming=True,
            include_sub_agent_streaming_events=True,
            on_event=on_event,
            on_permission_request=lambda *_: PermissionDecisionUserNotAvailable(),
            tools=tools,
            available_tools=[f"custom:{tool.name}" for tool in tools],
            system_message={"mode": "append", "content": self.instructions},
            enable_config_discovery=False,
            enable_on_demand_instruction_discovery=False,
            enable_file_hooks=False,
            enable_host_git_operations=False,
            enable_session_store=False,
            enable_skills=False,
        )
        # on() is a set in native SDK 1.0.14: recover an unsubscribe for the early callback.
        thread.unsubscribe = thread.session.on(on_event)

    async def _resolve(self, thread: ThreadContext, call_id: str, content: str) -> None:
        if thread.closed:
            raise asyncio.CancelledError
        result = await thread.session.rpc.tools.handle_pending_tool_call(
            HandlePendingToolCallRequest(request_id=thread.pending[call_id], result=content)
        )
        if not result.success:
            raise ThreadConflict("Original pending SDK tool request is no longer available")

    @staticmethod
    def _source_busy(thread: ThreadContext, *, allow_frontend: bool = False) -> bool:
        return (
            bool(thread.mapper.argument_deltas)
            or any(child["status"] == "running" for child in thread.mapper.children.values())
            or any(
                tool["status"] == "running"
                and not (allow_frontend and call_id in thread.pending)
                for call_id, tool in thread.mapper.tools.items()
            )
        )

    def _classify(
        self, thread: ThreadContext, request: RunAgentInput
    ) -> tuple[str | None, list[tuple[str, str]]]:
        results: dict[str, str] = {}
        replayed_result = False
        for message in request.messages:
            if message.role != "tool":
                continue
            call_id, content = message.tool_call_id, message.content
            if not isinstance(content, str) or len(content) > self.max_output_chars:
                raise InputError("Tool result must be bounded text")
            if call_id in results and results[call_id] != content:
                raise ThreadConflict(
                    "Conflicting duplicate tool result", code="FRONTEND_TOOL_RESULT_CONFLICT"
                )
            if call_id in thread.pending:
                results[call_id] = content
            elif call_id in thread.resolved:
                if thread.resolved[call_id] != _digest(content):
                    raise ThreadConflict(
                        "Previously resolved tool result changed",
                        code="FRONTEND_TOOL_RESULT_CONFLICT",
                    )
                replayed_result = True
            elif call_id not in thread.mapper.tools:
                raise ThreadConflict("Unknown, expired, or wrong-thread tool result")
        users = [message for message in request.messages if message.role == "user"]
        latest = users[-1] if users else None
        prompt = None
        if latest:
            if not isinstance(latest.content, str) or not latest.content.strip():
                raise InputError("This adapter supports nonempty text user messages only")
            old = thread.user_messages.get(latest.id)
            if old is not None and old != _digest(latest.content):
                raise ThreadConflict("Previously sent user message changed")
            if old is None:
                if thread.pending:
                    raise ThreadConflict("Resolve pending frontend tools before a new user turn")
                prompt = latest.content
        if thread.pending and not results and not replayed_result:
            raise ThreadConflict("Missing pending frontend tool results")
        if prompt is None and not results and not thread.resolved:
            raise InputError("No new user message or owned tool results")
        return prompt, list(results.items())

    async def run(self, value: RunAgentInput | Mapping[str, Any]) -> AsyncIterator[BaseEvent]:
        """Stream typed events; call ``aclose()`` on disconnect to abort and release ownership."""
        request = validate_input(value, max_bytes=self.max_request_bytes)
        previous = self.threads.get(request.thread_id)
        if previous and previous.owner_task is not None and previous.owner_task.done():
            await self._drop(previous)
        thread = self._reserve(request)
        started = keep = False
        try:
            signature = json.dumps(
                [tool.model_dump(by_alias=True) for tool in request.tools], sort_keys=True
            )
            signature_changed = thread.session and signature != thread.tool_signature
            if signature_changed:
                registered = {tool["name"]: tool for tool in json.loads(thread.tool_signature)}
                incoming = json.loads(signature)
                retained_continuation = (thread.pending or thread.resolved) and all(
                    registered.get(tool["name"]) == tool for tool in incoming
                )
                if not retained_continuation:
                    raise ThreadConflict("Tool declarations cannot change within a live thread")
            prompt, results = self._classify(thread, request)
            if signature_changed and prompt is not None:
                raise ThreadConflict("Tool declarations cannot change within a live thread")
            if prompt is not None:
                thread.state = (
                    self.state_validator(thread.state, request.state)
                    if self.state_validator
                    else request.state
                )
            elif results:
                incoming = (
                    self.state_validator(thread.handoff_state, request.state)
                    if self.state_validator
                    else request.state
                )
                if thread.state == thread.handoff_state:
                    thread.state = incoming
                elif incoming != thread.handoff_state and incoming != thread.state:
                    raise ThreadConflict("State changed while frontend tools were pending")
            if not thread.session:
                thread.frontend_names = {tool.name for tool in request.tools}
                thread.tool_signature = signature
                await asyncio.wait_for(self._create(thread, request), self.run_timeout)
            started = True
            yield RunStartedEvent(thread_id=request.thread_id, run_id=request.run_id)
            yield StateSnapshotEvent(snapshot=thread.state)
            async with asyncio.timeout(self.run_timeout):
                if results:
                    thread.epoch += 1
                    resolutions = [
                        asyncio.create_task(self._resolve(thread, call_id, content))
                        for call_id, content in results
                    ]
                    thread.rpc_tasks.update(resolutions)
                    try:
                        await asyncio.gather(*resolutions)
                    finally:
                        await _cancel_tasks(resolutions)
                        thread.rpc_tasks.difference_update(resolutions)
                    if thread.closed:
                        raise asyncio.CancelledError
                    for call_id, content in results:
                        thread.resolved[call_id] = _digest(content)
                        thread.pending.pop(call_id)
                        thread.expected_frontend.discard(call_id)
                replay_only = prompt is None and not results
                while True:
                    if thread.closed:
                        raise asyncio.CancelledError
                    if thread.overflow:
                        raise ValueError("SDK event queue limit exceeded")
                    if thread.queue.empty():
                        if prompt is not None and not self._source_busy(thread):
                            # Drain the previous source epoch before dispatching a new user turn.
                            thread.epoch += 1
                            thread.mapper.seen.clear()
                            latest = next(
                                message for message in reversed(request.messages)
                                if message.role == "user"
                            )
                            thread.user_messages[latest.id] = _digest(latest.content)
                            context = json.dumps(
                                thread.state, ensure_ascii=False, separators=(",", ":")
                            )
                            await thread.session.send(
                                f"Application state at this turn boundary: {context}\n\n{prompt}"
                            )
                            prompt = None
                        elif replay_only and not self._source_busy(thread, allow_frontend=True):
                            for event in thread.mapper.finish():
                                yield event
                            keep = True
                            yield RunFinishedEvent(
                                thread_id=request.thread_id, run_id=request.run_id
                            )
                            return
                    pending_ready = (
                        bool(thread.pending)
                        and thread.expected_frontend.issubset(thread.pending)
                        and not self._source_busy(thread, allow_frontend=True)
                    )
                    try:
                        raw = await asyncio.wait_for(
                            thread.queue.get(),
                            self.handoff_delay if pending_ready else self.run_timeout,
                        )
                    except TimeoutError:
                        if not pending_ready:
                            raise
                        if not thread.queue.empty():
                            continue
                        thread.handoff_state = copy.deepcopy(thread.state)
                        for event in thread.mapper.finish():
                            yield event
                        keep = True
                        yield RunFinishedEvent(thread_id=request.thread_id, run_id=request.run_id)
                        return
                    if thread.overflow:
                        raise ValueError("SDK event queue limit exceeded")
                    if isinstance(raw, BaseEvent):
                        # Explicit host-produced activity is distinct from the SDK event mapper.
                        if (
                            isinstance(raw, ActivitySnapshotEvent)
                            and raw.activity_type == "copilot-sdk:tool"
                        ):
                            activity = raw.content
                            if activity.get("toolCallId") in thread.mapper.tools:
                                thread.mapper.tools[activity["toolCallId"]].update(activity)
                        yield raw
                        continue
                    kind, data = raw["type"], raw["data"]
                    if kind == "assistant.message":
                        for tool in data.get("toolRequests", []):
                            if (
                                tool["name"] in thread.frontend_names
                                and tool["toolCallId"] not in thread.resolved
                            ):
                                thread.expected_frontend.add(tool["toolCallId"])
                    if (
                        kind == "external_tool.requested"
                        and data["toolName"] in thread.frontend_names
                    ):
                        call_id, request_id = data["toolCallId"], data["requestId"]
                        if (
                            not isinstance(call_id, str)
                            or not call_id.strip()
                            or not isinstance(request_id, str)
                            or not request_id.strip()
                        ):
                            raise ThreadConflict(
                                "SDK frontend tool identity is missing",
                                code="FRONTEND_TOOL_IDENTITY_ERROR",
                            )
                        if data.get("sessionId") != thread.session.session_id:
                            raise ThreadConflict("SDK pending request session mismatch")
                        if (
                            request_id in thread.request_owners
                            and thread.request_owners[request_id] != call_id
                        ):
                            raise ThreadConflict(
                                "SDK pending request ID reused", code="FRONTEND_TOOL_IDENTITY_ERROR"
                            )
                        if (
                            call_id in thread.resolved
                            and thread.request_owners.get(request_id) != call_id
                        ):
                            raise ThreadConflict(
                                "SDK answered tool call ID reused",
                                code="FRONTEND_TOOL_IDENTITY_ERROR",
                            )
                        if call_id not in thread.resolved:
                            if call_id in thread.pending and thread.pending[call_id] != request_id:
                                raise ThreadConflict("SDK tool call request ownership changed")
                            thread.request_owners[request_id] = call_id
                            thread.pending[call_id] = request_id
                    for event in thread.mapper.map_event(raw):
                        if (
                            isinstance(event, ToolCallResultEvent)
                            and thread.mapper.tools[event.tool_call_id]["toolName"]
                            in thread.frontend_names
                        ):
                            continue  # The ordinary ToolMessage already owns the browser result.
                        yield event
                    if (
                        kind == "external_tool.requested"
                        and data["toolCallId"] in thread.pending
                        and thread.mapper.tools[data["toolCallId"]].get("parentToolCallId")
                    ):
                        raise ThreadConflict(
                            "Child frontend handoff requires a verified suspended-child contract",
                            code="SUBAGENT_FRONTEND_HANDOFF_UNSUPPORTED",
                        )
                    if kind == "session.error":
                        raise RuntimeError("SDK session failed")
                    if kind in ("abort", "agent.interrupted") and not raw.get("agentId"):
                        raise RuntimeError("SDK run was interrupted")
                    if (
                        kind == "session.idle"
                        and raw.get("_epoch", thread.epoch) == thread.epoch
                        and prompt is None
                        and not thread.pending
                        and not self._source_busy(thread)
                    ):
                        keep = True
                        yield RunFinishedEvent(thread_id=request.thread_id, run_id=request.run_id)
                        return
        except (GeneratorExit, asyncio.CancelledError):
            raise
        except Exception as exc:
            if not started:
                # Invalid requests must not destroy a valid pending browser handoff.
                keep = thread.session is not None
                raise
            for event in thread.mapper.finish(cancelled=True):
                yield event
            yield RunErrorEvent(
                message="Copilot run failed or exceeded its limits",
                code=exc.code if isinstance(exc, InputError) else "COPILOT_RUN_ERROR",
            )
        finally:
            thread.active = False
            thread.owner_task = None
            thread.updated = time.monotonic()
            if not keep:
                await self._drop(thread)
