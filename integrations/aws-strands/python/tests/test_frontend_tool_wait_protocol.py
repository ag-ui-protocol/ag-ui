"""Request-side protocol for resuming native frontend-tool waits."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    AssistantMessage,
    EventType,
    FunctionCall,
    Interrupt,
    ResumeEntry,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands.agent.state import AgentState
from strands.interrupt import Interrupt as StrandsInterrupt
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent, _build_strands_history
from ag_ui_strands.config import StrandsAgentConfig
from ag_ui_strands.frontend_tool_wait import (
    FRONTEND_TOOL_RESPONSE_KEY,
    FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
    FrontendToolWaitBatch,
    FrontendToolWaitCall,
    frontend_tool_wait_reason,
)
from ag_ui_strands.session_reconcile import (
    AG_UI_TOOL_CALL_MAP_STATE_KEY,
    AG_UI_WIRE_MAP_STATE_KEY,
)

WAIT_STATE_KEY = "ag_ui_frontend_tool_wait"
SERVER_RESPONSE_STATE_KEY = "ag_ui_frontend_tool_wait_server_responses"


@dataclass
class _FakeAgentResult:
    stop_reason: str = "end_turn"
    message: dict = field(default_factory=lambda: {"role": "assistant", "content": []})
    metrics: Any = None
    state: Any = field(default_factory=dict)
    interrupts: Sequence[StrandsInterrupt] | None = None
    structured_output: Any = None


class _State:
    def __init__(self, values: dict[str, Any] | None = None) -> None:
        self.values = dict(values or {})
        self.set_calls: list[tuple[str, Any]] = []

    def get(self, key: str | None = None) -> Any:
        return dict(self.values) if key is None else self.values.get(key)

    def set(self, key: str, value: Any) -> None:
        self.values[key] = value
        self.set_calls.append((key, value))


class _InterruptState:
    def __init__(self, interrupts: Sequence[StrandsInterrupt]) -> None:
        self.activated = True
        self.interrupts = {interrupt.id: interrupt for interrupt in interrupts}

    def deactivate(self) -> None:
        self.activated = False


class _ScriptedInnerAgent:
    def __init__(
        self,
        batch: FrontendToolWaitBatch,
        interrupts: Sequence[StrandsInterrupt],
        *,
        failures: int = 0,
        next_interrupt: StrandsInterrupt | None = None,
        current_tool_use: dict[str, Any] | None = None,
        force_stop_reason: str | None = None,
        accept_resume_before_force_stop: bool = False,
    ) -> None:
        self.state = _State(
            {
                WAIT_STATE_KEY: batch.to_dict(),
                AG_UI_TOOL_CALL_MAP_STATE_KEY: {
                    call.native_tool_use_id: {
                        "name": f"tool-{call.wire_tool_call_id}",
                        "strands_tool_id": call.native_tool_use_id,
                        "is_frontend": True,
                        "is_proxy": True,
                        "continue_after_frontend_call": False,
                        "use_streaming": True,
                        "message_id": f"assistant-{call.wire_tool_call_id}",
                    }
                    for call in batch.calls
                },
                AG_UI_WIRE_MAP_STATE_KEY: {
                    call.wire_tool_call_id: call.native_tool_use_id
                    for call in batch.calls
                },
            }
        )
        self._interrupt_state = _InterruptState(interrupts)
        self.tool_registry = ToolRegistry()
        self.messages: list[dict[str, Any]] = []
        self.prompts: list[Any] = []
        self.failures = failures
        self.next_interrupt = next_interrupt
        self.current_tool_use = current_tool_use
        self.force_stop_reason = force_stop_reason
        self.accept_resume_before_force_stop = accept_resume_before_force_stop

    async def stream_async(self, prompt: Any):
        self.prompts.append(prompt)
        if self.current_tool_use is not None:
            yield {"current_tool_use": self.current_tool_use}
        if self.failures:
            self.failures -= 1
            raise RuntimeError("scripted resume failure")
        if isinstance(prompt, list) and all(
            isinstance(item, dict) and "interruptResponse" in item for item in prompt
        ):
            if self.force_stop_reason is not None:
                if self.accept_resume_before_force_stop:
                    self._interrupt_state.deactivate()
                yield {
                    "force_stop": True,
                    "force_stop_reason": self.force_stop_reason,
                }
                return
            self._interrupt_state.deactivate()
            if self.next_interrupt is not None:
                next_interrupt = self.next_interrupt
                self.next_interrupt = None
                self._interrupt_state = _InterruptState([next_interrupt])
                yield {
                    "result": _FakeAgentResult(
                        stop_reason="interrupt", interrupts=[next_interrupt]
                    )
                }
                return
        yield {"result": _FakeAgentResult()}


def _template_agent() -> MagicMock:
    template = MagicMock()
    template.model = MagicMock()
    template.system_prompt = "You are helpful"
    template.tool_registry.registry = {}
    template.record_direct_tool_call = True
    return template


def _frontend_interrupt(interrupt_id: str, native_id: str) -> StrandsInterrupt:
    return StrandsInterrupt(
        id=interrupt_id,
        name=FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
        reason=frontend_tool_wait_reason(native_tool_use_id=native_id),
    )


def _server_interrupt(interrupt_id: str = "server-1") -> StrandsInterrupt:
    return StrandsInterrupt(id=interrupt_id, name="confirm", reason={"question": "ok?"})


def _batch(
    *wire_ids: str,
    tombstones: Sequence[str] = (),
    checkpoint_message_ids: Sequence[str] = ("historical-user",),
) -> FrontendToolWaitBatch:
    return FrontendToolWaitBatch(
        calls=[
            FrontendToolWaitCall(
                interrupt_id=f"interrupt-{wire_id}",
                native_tool_use_id=f"native-{wire_id}",
                wire_tool_call_id=wire_id,
            )
            for wire_id in wire_ids
        ],
        last_completed_wire_ids=tombstones,
        checkpoint_message_ids=checkpoint_message_ids,
    )


def _build_agent(
    batch: FrontendToolWaitBatch,
    *,
    server_interrupts: Sequence[StrandsInterrupt] = (),
    omit_frontend_interrupt_ids: Sequence[str] = (),
    failures: int = 0,
    next_interrupt: StrandsInterrupt | None = None,
    current_tool_use: dict[str, Any] | None = None,
    force_stop_reason: str | None = None,
    accept_resume_before_force_stop: bool = False,
) -> tuple[StrandsAgent, _ScriptedInnerAgent]:
    frontend_interrupts = [
        _frontend_interrupt(call.interrupt_id, call.native_tool_use_id)
        for call in batch.calls
        if call.interrupt_id not in omit_frontend_interrupt_ids
    ]
    inner = _ScriptedInnerAgent(
        batch,
        [*frontend_interrupts, *server_interrupts],
        failures=failures,
        next_interrupt=next_interrupt,
        current_tool_use=current_tool_use,
        force_stop_reason=force_stop_reason,
        accept_resume_before_force_stop=accept_resume_before_force_stop,
    )
    adapter = StrandsAgent(
        _template_agent(), name="test-agent", config=StrandsAgentConfig()
    )
    adapter._agents_by_thread["thread-1"] = inner
    if server_interrupts:
        adapter._pending_interrupts_by_thread["thread-1"] = {
            interrupt.id: Interrupt(
                id=interrupt.id,
                reason=interrupt.name,
            )
            for interrupt in server_interrupts
        }
    return adapter, inner


def _input(
    messages: Sequence[Any] = (),
    *,
    resume: Sequence[ResumeEntry] | None = None,
    tools: Sequence[Tool] = (),
    run_id: str = "run-1",
) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1",
        run_id=run_id,
        state={},
        messages=list(messages),
        tools=list(tools),
        context=[],
        forwarded_props={},
        resume=list(resume) if resume is not None else None,
    )


def _tool(
    wire_id: str,
    content: str,
    *,
    error: str | None = None,
    message_id: str | None = None,
) -> ToolMessage:
    return ToolMessage(
        id=message_id or f"message-{wire_id}",
        content=content,
        tool_call_id=wire_id,
        error=error,
    )


async def _collect(adapter: StrandsAgent, input_data: RunAgentInput) -> list[Any]:
    return [event async for event in adapter.run(input_data)]


def _event_types(events: Sequence[Any]) -> list[EventType]:
    return [event.type for event in events]


def _stored_batch(inner: _ScriptedInnerAgent) -> FrontendToolWaitBatch:
    return FrontendToolWaitBatch.from_dict(inner.state.get(WAIT_STATE_KEY))


def _responses_by_id(prompt: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        item["interruptResponse"]["interruptId"]: item["interruptResponse"]["response"]
        for item in prompt
    }


def _completed_frontend_history(wire_id: str = "done") -> list[Any]:
    return [
        UserMessage(id="historical-user", content="do the work"),
        AssistantMessage(
            id="historical-assistant-tool",
            content="",
            tool_calls=[
                ToolCall(
                    id=wire_id,
                    function=FunctionCall(name="frontend_tool", arguments="{}"),
                )
            ],
        ),
        _tool(wire_id, '{"accepted": true}', message_id="historical-tool"),
        AssistantMessage(
            id="historical-assistant-final",
            content="The work is complete.",
        ),
    ]


@pytest.mark.asyncio
async def test_partial_out_of_order_result_is_staged_without_invoking_strands():
    adapter, inner = _build_agent(_batch("first", "second"))

    events = await _collect(adapter, _input([_tool("second", "two")]))

    assert _event_types(events) == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    assert events[1].tool_call_id == "first"
    assert inner.prompts == []
    stored = _stored_batch(inner)
    assert stored.calls[0].has_response is False
    assert stored.calls[0].end_handed_off is True
    assert stored.calls[1].content == "two"
    assert stored.calls[1].has_response is True
    assert stored.calls[1].end_handed_off is True
    assert [key for key, _ in inner.state.set_calls] == [
        WAIT_STATE_KEY,
        WAIT_STATE_KEY,
    ]


@pytest.mark.asyncio
async def test_incomplete_same_history_retry_replays_unhanded_ends_without_strands():
    batch = _batch("first", "second", "third").mark_end_handed_off("first")
    adapter, inner = _build_agent(batch)

    events = await _collect(adapter, _input())

    assert _event_types(events) == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    assert [event.tool_call_id for event in events[1:3]] == ["second", "third"]
    assert inner.prompts == []
    assert [call.end_handed_off for call in _stored_batch(inner).calls] == [
        True,
        True,
        True,
    ]


@pytest.mark.asyncio
async def test_persisted_checkpoint_halt_still_replays_unhanded_frontend_end():
    original = _batch("call")
    halted = FrontendToolWaitBatch(
        calls=original.calls,
        checkpoint_message_ids=original.checkpoint_message_ids,
        stop_streaming_after_result=True,
    )
    adapter, inner = _build_agent(halted)

    events = await _collect(adapter, _input())

    assert _event_types(events) == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    assert events[1].tool_call_id == "call"
    persisted = _stored_batch(inner)
    assert persisted.calls[0].end_handed_off is True
    assert persisted.stop_streaming_after_result is True


@pytest.mark.parametrize("request_kind", ["duplicate", "continuation-only"])
@pytest.mark.asyncio
async def test_incomplete_duplicate_or_continuation_only_request_remains_a_barrier(
    request_kind: str,
):
    batch = _batch("first", "second").stage_responses(
        [{"tool_call_id": "first", "content": "original"}]
    )
    adapter, inner = _build_agent(batch)
    messages = (
        [_tool("first", "duplicate")]
        if request_kind == "duplicate"
        else [_tool("continue-true", "result")]
    )

    events = await _collect(adapter, _input(messages))

    assert _event_types(events) == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    assert events[1].tool_call_id == "second"
    assert inner.prompts == []
    assert _stored_batch(inner).calls[0].content == "original"


@pytest.mark.parametrize("phase_metadata", [None, "malformed"])
@pytest.mark.asyncio
async def test_unhanded_wait_with_invalid_end_phase_metadata_fails_loudly(
    phase_metadata: Any,
):
    adapter, inner = _build_agent(_batch("call"))
    if phase_metadata is None:
        inner.state.values.pop(AG_UI_TOOL_CALL_MAP_STATE_KEY)
    else:
        inner.state.values[AG_UI_TOOL_CALL_MAP_STATE_KEY] = phase_metadata

    events = await _collect(adapter, _input())

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "INTERRUPT_RESUME_ERROR"
    ]
    assert EventType.TOOL_CALL_END not in _event_types(events)
    assert EventType.RUN_FINISHED not in _event_types(events)
    assert inner.prompts == []


@pytest.mark.parametrize("content", ["", "false", "0", "null", "[]", "{}"])
@pytest.mark.asyncio
async def test_exact_falsy_looking_content_is_present_and_forwarded_unchanged(
    content: str,
):
    adapter, inner = _build_agent(_batch("call"))

    events = await _collect(adapter, _input([_tool("call", content)]))

    assert EventType.RUN_ERROR not in _event_types(events)
    response = _responses_by_id(inner.prompts[0])["interrupt-call"]
    assert response == {
        FRONTEND_TOOL_RESPONSE_KEY: {"content": content, "is_error": False}
    }


@pytest.mark.asyncio
async def test_explicit_tool_message_error_is_forwarded_without_parsing_content():
    adapter, inner = _build_agent(_batch("call"))

    await _collect(adapter, _input([_tool("call", "cancelled", error="boom")]))

    response = _responses_by_id(inner.prompts[0])["interrupt-call"]
    assert response == {
        FRONTEND_TOOL_RESPONSE_KEY: {"content": "cancelled", "is_error": True}
    }


@pytest.mark.asyncio
async def test_first_result_wins_within_and_across_requests():
    adapter, inner = _build_agent(_batch("a", "b"))

    await _collect(
        adapter,
        _input(
            [_tool("a", "first", message_id="m1"), _tool("a", "later", message_id="m2")]
        ),
    )
    await _collect(
        adapter,
        _input(
            [_tool("a", "different", message_id="m3"), _tool("b", "second")],
            run_id="run-2",
        ),
    )

    responses = _responses_by_id(inner.prompts[0])
    assert responses["interrupt-a"][FRONTEND_TOOL_RESPONSE_KEY]["content"] == "first"
    assert responses["interrupt-b"][FRONTEND_TOOL_RESPONSE_KEY]["content"] == "second"


@pytest.mark.asyncio
async def test_immediately_completed_tombstone_is_a_noop_without_content_comparison():
    adapter, inner = _build_agent(_batch(tombstones=["done"]))
    inner._interrupt_state = _InterruptState([])
    inner._interrupt_state.activated = False

    events = await _collect(adapter, _input([_tool("done", "different")]))

    assert _event_types(events) == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert inner.prompts == []


@pytest.mark.asyncio
async def test_full_history_tombstone_retry_is_noop_without_rewriting_canonical_history():
    historical_prefix = [
        UserMessage(id="earlier-user", content="look up the earlier value"),
        AssistantMessage(
            id="earlier-assistant-tool",
            content="",
            tool_calls=[
                ToolCall(
                    id="earlier-call",
                    function=FunctionCall(name="earlier_tool", arguments="{}"),
                )
            ],
        ),
        _tool(
            "earlier-call",
            '{"value": "historical"}',
            message_id="earlier-tool-result",
        ),
        AssistantMessage(
            id="earlier-assistant-final",
            content="The earlier value was historical.",
        ),
        UserMessage(id="historical-user", content="do the work"),
    ]
    adapter, inner = _build_agent(
        _batch(),
        current_tool_use={
            "name": "frontend_tool",
            "toolUseId": "native-done",
            "input": "{}",
        },
    )
    inner.state = AgentState({WAIT_STATE_KEY: _batch().to_dict()})
    inner._interrupt_state.activated = False
    first_events = await _collect(
        adapter,
        _input(
            historical_prefix,
            tools=[
                Tool(
                    name="frontend_tool",
                    description="runs in the browser",
                    parameters={},
                )
            ],
        ),
    )
    wire_id = next(
        event.tool_call_id
        for event in first_events
        if event.type == EventType.TOOL_CALL_START
    )
    assert inner.state.get(AG_UI_WIRE_MAP_STATE_KEY) == {wire_id: "native-done"}

    history = [
        *historical_prefix,
        AssistantMessage(
            id="historical-assistant-tool",
            content="",
            tool_calls=[
                ToolCall(
                    id=wire_id,
                    function=FunctionCall(name="frontend_tool", arguments="{}"),
                )
            ],
        ),
        _tool(wire_id, '{"accepted": true}', message_id="historical-tool"),
        AssistantMessage(
            id="historical-assistant-final",
            content="The work is complete.",
        ),
    ]
    inner.current_tool_use = None
    inner.state.set(
        WAIT_STATE_KEY,
        _batch(
            tombstones=[wire_id],
            checkpoint_message_ids=[message.id for message in historical_prefix],
        ).to_dict(),
    )
    restored = _build_strands_history(history)
    inner.messages = restored.copy()
    input_data = _input(history)

    events = await _collect(adapter, input_data)

    assert _event_types(events) == [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    assert len(inner.prompts) == 1
    assert input_data.messages == history
    assert inner.messages == restored


@pytest.mark.asyncio
async def test_post_checkpoint_unrelated_tool_result_remains_actionable():
    history = _completed_frontend_history()
    post_checkpoint_result = _tool(
        "unrelated-call",
        '{"value": "new"}',
        message_id="post-checkpoint-tool-result",
    )
    adapter, inner = _build_agent(
        _batch(
            tombstones=["done"],
            checkpoint_message_ids=[message.id for message in history],
        )
    )
    inner._interrupt_state.activated = False
    canonical = [*history, post_checkpoint_result]
    input_data = _input(canonical)

    events = await _collect(adapter, input_data)

    assert EventType.RUN_ERROR not in _event_types(events)
    assert len(inner.prompts) == 1
    assert input_data.messages == canonical


@pytest.mark.asyncio
async def test_full_history_tombstone_with_new_user_preserves_history_and_runs_new_turn():
    history = _completed_frontend_history()
    next_user = UserMessage(id="new-user", content="start the next task")
    canonical = [*history, next_user]
    adapter, inner = _build_agent(_batch(tombstones=["done"]))
    inner.state = AgentState({WAIT_STATE_KEY: _batch(tombstones=["done"]).to_dict()})
    inner._interrupt_state.activated = False
    inner.messages = [{"role": "user", "content": [{"text": "transformed"}]}]
    input_data = _input(canonical)

    events = await _collect(adapter, input_data)

    assert EventType.RUN_ERROR not in _event_types(events)
    assert len(inner.prompts) == 1
    assert input_data.messages == canonical
    assert inner.messages == _build_strands_history(canonical)
    assert inner.messages[-1] == {
        "role": "user",
        "content": [{"text": "start the next task"}],
    }


@pytest.mark.asyncio
async def test_tombstone_is_filtered_but_legacy_tool_message_still_runs():
    adapter, inner = _build_agent(_batch(tombstones=["done"]))
    inner._interrupt_state.activated = False

    events = await _collect(
        adapter,
        _input([_tool("done", "duplicate"), _tool("legacy", "continue")]),
    )

    assert EventType.RUN_ERROR not in _event_types(events)
    assert len(inner.prompts) == 1


@pytest.mark.asyncio
async def test_tombstone_is_filtered_but_server_resume_still_runs():
    server = _server_interrupt()
    adapter, inner = _build_agent(
        _batch(tombstones=["done"]), server_interrupts=[server]
    )
    adapter._pending_interrupts_by_thread["thread-1"] = {}

    events = await _collect(
        adapter,
        _input(
            [_tool("done", "duplicate")],
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    assert EventType.RUN_ERROR not in _event_types(events)
    assert set(_responses_by_id(inner.prompts[0])) == {server.id}


@pytest.mark.asyncio
async def test_tombstone_does_not_remove_canonical_history_before_valid_user_turn():
    adapter, inner = _build_agent(_batch(tombstones=["done"]))
    inner._interrupt_state.activated = False

    events = await _collect(
        adapter,
        _input([_tool("done", "duplicate"), UserMessage(id="new", content="next")]),
    )

    assert EventType.RUN_ERROR not in _event_types(events)
    assert len(inner.prompts) == 1
    assert any(
        block.get("toolResult", {}).get("toolUseId") == "done"
        for message in inner.messages
        for block in message.get("content", [])
    )


@pytest.mark.asyncio
async def test_pending_wait_rejects_a_new_user_turn_before_adapter_mutation():
    adapter, inner = _build_agent(_batch("call"))

    events = await _collect(adapter, _input([UserMessage(id="new", content="next")]))

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "PENDING_INTERRUPTS"
    ]
    assert inner.prompts == []
    assert inner.state.set_calls == []


@pytest.mark.asyncio
async def test_completion_cannot_be_combined_with_a_new_user_turn():
    adapter, inner = _build_agent(_batch("call"))

    events = await _collect(
        adapter,
        _input([_tool("call", "answer"), UserMessage(id="new", content="next")]),
    )

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "PENDING_INTERRUPTS"
    ]
    assert inner.prompts == []
    assert _stored_batch(inner).calls[0].has_response is False


@pytest.mark.parametrize("server_first", [True, False])
@pytest.mark.asyncio
async def test_frontend_and_server_responses_may_arrive_in_either_order(
    server_first: bool,
):
    server = _server_interrupt()
    adapter, inner = _build_agent(_batch("call"), server_interrupts=[server])
    adapter._pending_interrupts_by_thread["thread-1"] = {
        server.id: Interrupt(id=server.id, reason="confirm")
    }
    server_resume = [
        ResumeEntry(
            interrupt_id=server.id, status="resolved", payload={"approved": True}
        )
    ]

    first = (
        _input(resume=server_resume)
        if server_first
        else _input([_tool("call", "answer")])
    )
    second = (
        _input([_tool("call", "answer")], run_id="run-2")
        if server_first
        else _input(resume=server_resume, run_id="run-2")
    )
    first_events = await _collect(adapter, first)

    expected_first_types = [EventType.RUN_STARTED, EventType.RUN_FINISHED]
    if server_first:
        expected_first_types.insert(1, EventType.TOOL_CALL_END)
        assert first_events[1].tool_call_id == "call"
    assert _event_types(first_events) == expected_first_types
    if server_first:
        assert first_events[-1].outcome.type == "success"
    else:
        assert first_events[-1].outcome.type == "interrupt"
        assert [interrupt.id for interrupt in first_events[-1].outcome.interrupts] == [
            server.id
        ]
        assert set(adapter._pending_interrupts_by_thread["thread-1"]) == {server.id}
    second_events = await _collect(adapter, second)
    assert EventType.RUN_ERROR not in _event_types(second_events)
    assert len(inner.prompts) == 1
    responses = _responses_by_id(inner.prompts[0])
    assert responses["interrupt-call"] == {
        FRONTEND_TOOL_RESPONSE_KEY: {"content": "answer", "is_error": False}
    }
    assert responses[server.id] == {"response": {"approved": True}}
    assert "thread-1" not in adapter._pending_interrupts_by_thread
    assert inner.state.get(SERVER_RESPONSE_STATE_KEY) == {}


@pytest.mark.asyncio
async def test_server_first_resume_allows_replayed_user_history():
    history = _completed_frontend_history("call")[:2]
    server = _server_interrupt()
    adapter, inner = _build_agent(_batch("call"), server_interrupts=[server])
    inner.messages = _build_strands_history(history)

    events = await _collect(
        adapter,
        _input(
            history,
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    assert _event_types(events) == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    assert events[1].tool_call_id == "call"
    assert inner.prompts == []
    assert inner.state.get(SERVER_RESPONSE_STATE_KEY)[server.id] == {
        "response": {"approved": True}
    }


@pytest.mark.asyncio
async def test_pending_completion_accepts_checkpoint_user_after_state_context_augmentation():
    history = _completed_frontend_history("call")[:2]
    adapter, inner = _build_agent(_batch("call"))
    inner.messages = [
        {
            "role": "user",
            "content": [{"text": "state context\n\noriginal turn"}],
        }
    ]

    events = await _collect(
        adapter,
        _input([*history, _tool("call", "answer")]),
    )

    assert EventType.RUN_ERROR not in _event_types(events)
    assert len(inner.prompts) == 1
    assert set(_responses_by_id(inner.prompts[0])) == {"interrupt-call"}


@pytest.mark.parametrize(
    "native_history",
    [
        [],
        [{"role": "assistant", "content": [{"text": "provider transformed"}]}],
    ],
    ids=["truncated", "transformed"],
)
@pytest.mark.asyncio
async def test_pending_completion_uses_checkpoint_ids_not_native_history_shape(
    native_history: list[dict[str, Any]],
):
    history = _completed_frontend_history("call")[:2]
    adapter, inner = _build_agent(_batch("call"))
    inner.messages = native_history

    events = await _collect(
        adapter,
        _input([*history, _tool("call", "answer")]),
    )

    assert EventType.RUN_ERROR not in _event_types(events)
    assert len(inner.prompts) == 1


@pytest.mark.asyncio
async def test_replayed_user_classification_never_rebuilds_native_history(monkeypatch):
    history = _completed_frontend_history("call")[:2]
    server = _server_interrupt()
    adapter, inner = _build_agent(_batch("call"), server_interrupts=[server])

    def fail_if_called(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("classification rebuilt native history")

    monkeypatch.setattr("ag_ui_strands.agent._build_strands_history", fail_if_called)
    events = await _collect(
        adapter,
        _input(
            history,
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    assert _event_types(events) == [
        EventType.RUN_STARTED,
        EventType.TOOL_CALL_END,
        EventType.RUN_FINISHED,
    ]
    assert events[1].tool_call_id == "call"
    assert inner.prompts == []


@pytest.mark.asyncio
async def test_server_resume_with_genuine_trailing_user_is_rejected_before_staging():
    history = _completed_frontend_history("call")[:2]
    server = _server_interrupt()
    adapter, inner = _build_agent(_batch("call"), server_interrupts=[server])
    inner.messages = _build_strands_history(history)

    events = await _collect(
        adapter,
        _input(
            [*history, UserMessage(id="new", content="new turn")],
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
        ),
    )

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "PENDING_INTERRUPTS"
    ]
    assert _stored_batch(inner) == _batch("call")
    assert inner.state.get(SERVER_RESPONSE_STATE_KEY) is None
    assert inner.state.set_calls == []


@pytest.mark.asyncio
async def test_complete_frontend_and_server_batch_resumes_together():
    server = _server_interrupt()
    adapter, inner = _build_agent(_batch("call"), server_interrupts=[server])

    await _collect(
        adapter,
        _input(
            [_tool("call", "answer")],
            resume=[
                ResumeEntry(interrupt_id=server.id, status="cancelled", payload=None)
            ],
        ),
    )

    assert set(_responses_by_id(inner.prompts[0])) == {"interrupt-call", server.id}
    assert _responses_by_id(inner.prompts[0])[server.id] == {"cancelled": True}


@pytest.mark.asyncio
async def test_mixed_server_resume_preserves_expiry_validation():
    server = _server_interrupt()
    adapter, inner = _build_agent(_batch("call"), server_interrupts=[server])
    adapter._pending_interrupts_by_thread["thread-1"] = {
        server.id: Interrupt(
            id=server.id,
            reason="confirm",
            expires_at="2000-01-01T00:00:00+00:00",
        )
    }

    events = await _collect(
        adapter,
        _input(
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ]
        ),
    )

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "INTERRUPT_EXPIRED"
    ]
    assert inner.state.get(SERVER_RESPONSE_STATE_KEY) is None


@pytest.mark.asyncio
async def test_mixed_server_resume_preserves_response_schema_validation():
    server = _server_interrupt()
    adapter, inner = _build_agent(_batch("call"), server_interrupts=[server])
    adapter._pending_interrupts_by_thread["thread-1"] = {
        server.id: Interrupt(
            id=server.id,
            reason="confirm",
            response_schema={
                "type": "object",
                "properties": {"approved": {"type": "boolean"}},
                "required": ["approved"],
            },
        )
    }

    events = await _collect(
        adapter,
        _input(
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": "yes"},
                )
            ]
        ),
    )

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "INVALID_PAYLOAD"
    ]
    assert inner.state.get(SERVER_RESPONSE_STATE_KEY) is None


@pytest.mark.parametrize("invalid_kind", ["expired", "malformed"])
@pytest.mark.asyncio
async def test_mixed_invalid_server_response_does_not_stage_frontend_candidate(
    invalid_kind: str,
):
    server = _server_interrupt()
    original = _batch("call")
    adapter, inner = _build_agent(original, server_interrupts=[server])
    if invalid_kind == "expired":
        invalid_metadata = Interrupt(
            id=server.id,
            reason="confirm",
            expires_at="2000-01-01T00:00:00+00:00",
        )
        expected_code = "INTERRUPT_EXPIRED"
    else:
        invalid_metadata = Interrupt(
            id=server.id,
            reason="confirm",
            response_schema={
                "type": "object",
                "properties": {"approved": {"type": "boolean"}},
                "required": ["approved"],
            },
        )
        expected_code = "INVALID_PAYLOAD"
    adapter._pending_interrupts_by_thread["thread-1"] = {server.id: invalid_metadata}

    rejected = await _collect(
        adapter,
        _input(
            [_tool("call", "rejected candidate")],
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": "yes"},
                )
            ],
        ),
    )

    assert [event.code for event in rejected if event.type == EventType.RUN_ERROR] == [
        expected_code
    ]
    assert _stored_batch(inner) == original
    assert inner.state.get(SERVER_RESPONSE_STATE_KEY) is None

    adapter._pending_interrupts_by_thread["thread-1"] = {
        server.id: Interrupt(id=server.id, reason="confirm")
    }
    accepted = await _collect(
        adapter,
        _input(
            [_tool("call", "corrected candidate")],
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
            run_id="run-2",
        ),
    )

    assert EventType.RUN_ERROR not in _event_types(accepted)
    assert _responses_by_id(inner.prompts[0])["interrupt-call"] == {
        FRONTEND_TOOL_RESPONSE_KEY: {
            "content": "corrected candidate",
            "is_error": False,
        }
    }


@pytest.mark.asyncio
async def test_missing_native_frontend_interrupt_metadata_fails_loudly_without_model_call():
    adapter, inner = _build_agent(
        _batch("call"), omit_frontend_interrupt_ids=["interrupt-call"]
    )

    events = await _collect(adapter, _input([_tool("call", "answer")]))

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "INTERRUPT_RESUME_ERROR"
    ]
    assert inner.prompts == []
    assert _stored_batch(inner).calls[0].has_response is False


@pytest.mark.asyncio
async def test_untracked_native_frontend_interrupt_metadata_fails_loudly():
    adapter, inner = _build_agent(_batch("call"))
    unknown = _frontend_interrupt("interrupt-unknown", "native-unknown")
    inner._interrupt_state.interrupts[unknown.id] = unknown

    events = await _collect(adapter, _input([_tool("call", "answer")]))

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "INTERRUPT_RESUME_ERROR"
    ]
    assert inner.prompts == []


@pytest.mark.asyncio
async def test_malformed_persisted_wait_state_fails_loudly():
    adapter, inner = _build_agent(_batch("call"))
    inner.state.values[WAIT_STATE_KEY] = "not-a-batch"

    events = await _collect(adapter, _input([_tool("call", "answer")]))

    assert [event.code for event in events if event.type == EventType.RUN_ERROR] == [
        "INTERRUPT_RESUME_ERROR"
    ]
    assert inner.prompts == []


@pytest.mark.asyncio
async def test_resume_failure_leaves_complete_wait_retryable():
    adapter, inner = _build_agent(_batch("call"), failures=1)

    failed = await _collect(adapter, _input([_tool("call", "answer")]))
    retried = await _collect(
        adapter, _input([_tool("call", "different")], run_id="run-2")
    )

    assert [event.code for event in failed if event.type == EventType.RUN_ERROR] == [
        "STRANDS_ERROR"
    ]
    assert EventType.RUN_ERROR not in _event_types(retried)
    assert len(inner.prompts) == 2
    assert _responses_by_id(inner.prompts[1])["interrupt-call"] == {
        FRONTEND_TOOL_RESPONSE_KEY: {"content": "answer", "is_error": False}
    }


@pytest.mark.asyncio
async def test_force_stop_before_frontend_resume_acceptance_preserves_retry():
    reason = "provider failed before accepting the resume"
    adapter, inner = _build_agent(
        _batch("call"),
        force_stop_reason=reason,
        accept_resume_before_force_stop=False,
    )

    failed = await _collect(adapter, _input([_tool("call", "answer")]))

    errors = [event for event in failed if event.type == EventType.RUN_ERROR]
    assert [(event.code, event.message) for event in errors] == [
        ("STRANDS_FORCE_STOP", reason)
    ]
    assert EventType.RUN_FINISHED not in _event_types(failed)
    staged = _stored_batch(inner)
    assert len(staged.calls) == 1
    assert staged.calls[0].has_response is True
    assert staged.last_completed_wire_ids == ()

    inner.force_stop_reason = None
    retried = await _collect(
        adapter, _input([_tool("call", "answer")], run_id="run-2")
    )

    assert EventType.RUN_ERROR not in _event_types(retried)
    assert _stored_batch(inner).calls == ()


@pytest.mark.asyncio
async def test_force_stop_after_frontend_resume_acceptance_consumes_response():
    reason = "provider failed after accepting the resume"
    adapter, inner = _build_agent(
        _batch("call"),
        force_stop_reason=reason,
        accept_resume_before_force_stop=True,
    )

    events = await _collect(adapter, _input([_tool("call", "answer")]))

    errors = [event for event in events if event.type == EventType.RUN_ERROR]
    assert [(event.code, event.message) for event in errors] == [
        ("STRANDS_FORCE_STOP", reason)
    ]
    assert EventType.RUN_FINISHED not in _event_types(events)
    consumed = _stored_batch(inner)
    assert consumed.calls == ()
    assert consumed.last_completed_wire_ids == ("call",)


@pytest.mark.asyncio
async def test_successful_native_resume_consumes_calls_and_replaces_tombstones():
    batch = _batch("new", tombstones=["old"])
    adapter, inner = _build_agent(batch)

    await _collect(adapter, _input([_tool("new", "answer")]))

    consumed = _stored_batch(inner)
    assert consumed.calls == ()
    assert consumed.last_completed_wire_ids == ("new",)
    assert consumed.checkpoint_message_ids == ("historical-user",)
    assert inner.state.get(SERVER_RESPONSE_STATE_KEY) in (None, {})


@pytest.mark.asyncio
async def test_accepted_frontend_resume_is_consumed_before_new_server_interrupt():
    next_server = _server_interrupt("server-next")
    adapter, inner = _build_agent(_batch("call"), next_interrupt=next_server)

    first_events = await _collect(adapter, _input([_tool("call", "answer")]))

    assert first_events[-1].outcome.type == "interrupt"
    consumed = _stored_batch(inner)
    assert consumed.calls == ()
    assert consumed.last_completed_wire_ids == ("call",)

    second_events = await _collect(
        adapter,
        _input(
            resume=[
                ResumeEntry(
                    interrupt_id=next_server.id,
                    status="resolved",
                    payload={"approved": True},
                )
            ],
            run_id="run-2",
        ),
    )

    assert EventType.RUN_ERROR not in _event_types(second_events)
    assert set(_responses_by_id(inner.prompts[1])) == {next_server.id}


@pytest.mark.asyncio
async def test_pure_server_interrupt_resume_behavior_is_unchanged():
    server = _server_interrupt()
    adapter, inner = _build_agent(_batch(), server_interrupts=[server])
    adapter._pending_interrupts_by_thread["thread-1"] = {}

    events = await _collect(
        adapter,
        _input(
            resume=[
                ResumeEntry(
                    interrupt_id=server.id,
                    status="resolved",
                    payload={"approved": False},
                )
            ]
        ),
    )

    assert EventType.RUN_ERROR not in _event_types(events)
    assert _responses_by_id(inner.prompts[0]) == {
        server.id: {"response": {"approved": False}}
    }
