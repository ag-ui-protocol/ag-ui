"""Tests for incremental tool-args streaming + predict_state ordering.

Regression: the adapter previously buffered every ``current_tool_use`` event
and emitted ``ToolCallStart``, ``ToolCallArgs`` (single full-payload delta),
``state_from_args`` snapshot and ``PredictState`` only at ``contentBlockStop``.
The frontend's predict_state machinery had nothing to apply during the args
stream and the authoritative ``StateSnapshot`` landed AFTER ``ToolCallEnd``,
producing a "re-stream" effect when the FE released its prediction buffer.

The streaming refactor emits in this order on the wire:

    PredictState (CustomEvent)        — once, before any args
    ToolCallStart
    ToolCallArgs (delta=...)          — one per current_tool_use growth
    ...
    ToolCallArgs (final flush delta)  — if any growth at contentBlockStop
    StateSnapshot (state_from_args)   — BEFORE ToolCallEnd
    ToolCallEnd
    MessagesSnapshot                  — assistant tool-call entry
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    EventType,
    RunAgentInput,
    Tool,
    UserMessage,
)
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import (
    PredictStateMapping,
    StrandsAgentConfig,
    ToolBehavior,
)


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent(thread_id: str, stream_events: list, config: StrandsAgentConfig) -> StrandsAgent:
    agent = StrandsAgent(_template_agent(), name="test-agent", config=config)
    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.session_manager = None

    async def _stream(_msg):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


def _state_from_args(context):
    """Synchronous variant — adapter awaits it via ``maybe_await``."""
    tool_input = context.tool_input
    if isinstance(tool_input, dict):
        return {"todos": tool_input.get("todos", [])}
    return None


def _config() -> StrandsAgentConfig:
    return StrandsAgentConfig(
        tool_behaviors={
            "manage_todos": ToolBehavior(
                state_from_args=_state_from_args,
                predict_state=[
                    PredictStateMapping(
                        state_key="todos",
                        tool="manage_todos",
                        tool_argument="todos",
                    )
                ],
            )
        },
    )


def _stream_events() -> list:
    """Simulate Strands streaming the JSON args char-by-char (split into chunks)."""
    full = '{"todos":[{"title":"a","status":"pending"}]}'
    chunks = [full[:1], full[:8], full[:20], full[:35], full]
    out = [
        {
            "current_tool_use": {
                "name": "manage_todos",
                "toolUseId": "st-todos",
                "input": chunk,
            }
        }
        for chunk in chunks
    ]
    out.append({"event": {"contentBlockStop": {}}})
    return out


class TestStreamingPredictState:
    THREAD = "stream-predict-thread"

    async def test_event_order_is_correct(self):
        agent = _build_agent(self.THREAD, _stream_events(), _config())
        inp = RunAgentInput(
            thread_id=self.THREAD,
            run_id="r1",
            state={},
            messages=[UserMessage(id="u1", content="add a todo")],
            tools=[],
            context=[],
            forwarded_props={},
        )
        events = await _collect(agent, inp)

        # Filter to the events relevant to ordering check.
        relevant = []
        for e in events:
            t = e.type
            if t == EventType.CUSTOM and getattr(e, "name", "") == "PredictState":
                relevant.append("predict_state")
            elif t == EventType.TOOL_CALL_START:
                relevant.append("tool_call_start")
            elif t == EventType.TOOL_CALL_ARGS:
                relevant.append("tool_call_args")
            elif t == EventType.TOOL_CALL_END:
                relevant.append("tool_call_end")
            elif t == EventType.STATE_SNAPSHOT:
                # Differentiate the initial empty snapshot from
                # the state_from_args one by checking payload.
                snapshot = getattr(e, "snapshot", None) or {}
                if "todos" in snapshot:
                    relevant.append("state_snapshot_todos")
                else:
                    relevant.append("state_snapshot_other")
            elif t == EventType.MESSAGES_SNAPSHOT:
                relevant.append("messages_snapshot")

        # PredictState lands before ToolCallStart.
        assert relevant.index("predict_state") < relevant.index("tool_call_start"), (
            f"PredictState must precede ToolCallStart; got {relevant}"
        )

        # At least two ToolCallArgs deltas (i.e. streaming, not single blob).
        args_count = relevant.count("tool_call_args")
        assert args_count >= 2, (
            f"Expected multiple ToolCallArgs deltas (streamed), got {args_count}: {relevant}"
        )

        # state_from_args snapshot lands BEFORE ToolCallEnd.
        snap_idx = relevant.index("state_snapshot_todos")
        end_idx = relevant.index("tool_call_end")
        assert snap_idx < end_idx, (
            f"state_from_args snapshot must precede ToolCallEnd; got {relevant}"
        )

        # ToolCallStart precedes the first args delta which precedes end.
        start_idx = relevant.index("tool_call_start")
        first_args = relevant.index("tool_call_args")
        assert start_idx < first_args < end_idx, (
            f"Expected start < args < end; got {relevant}"
        )

    async def test_args_deltas_sum_to_full_payload(self):
        agent = _build_agent(self.THREAD + "-sum", _stream_events(), _config())
        inp = RunAgentInput(
            thread_id=self.THREAD + "-sum",
            run_id="r1",
            state={},
            messages=[UserMessage(id="u1", content="add a todo")],
            tools=[],
            context=[],
            forwarded_props={},
        )
        events = await _collect(agent, inp)

        deltas = [
            e.delta
            for e in events
            if e.type == EventType.TOOL_CALL_ARGS
        ]
        joined = "".join(deltas)
        assert joined == '{"todos":[{"title":"a","status":"pending"}]}', (
            f"Concatenated deltas must equal full args; got {joined!r}"
        )