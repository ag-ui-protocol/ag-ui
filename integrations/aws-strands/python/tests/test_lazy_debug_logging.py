"""Regression tests for issue #3482: lazy and bounded DEBUG logging in StrandsAgent.run.

When DEBUG logging is disabled, the Strands event loop must not eagerly evaluate
``repr(event)`` (or other per-event payloads) via f-strings. When DEBUG logging
is enabled, huge event payloads (containers, large ``bytes``, and opaque objects
with expensive ``__repr__``) must be summarized in bounded time and memory
without invoking ``__repr__`` on opaque objects or formatting full byte buffers.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from ag_ui.core import EventType, RunAgentInput, UserMessage

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


class _ReprSpy:
    """Counts ``__repr__`` and ``__str__`` evaluations."""

    def __init__(self, label: str = "spy") -> None:
        self.label = label
        self.repr_calls = 0
        self.str_calls = 0

    def __repr__(self) -> str:
        self.repr_calls += 1
        return f"<ReprSpy {self.label}>"

    def __str__(self) -> str:
        self.str_calls += 1
        return f"<StrSpy {self.label}>"


class _FakeStrandsAgent:
    """Minimal Strands agent stub yielding caller-supplied events."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self._events = events
        self.messages: list[dict[str, Any]] = []
        self.system_prompt = "You are helpful"
        self.model = None
        self.tool_registry = type("Reg", (), {"registry": {}})()
        self.record_direct_tool_call = True

    async def stream_async(self, *args: Any, **kwargs: Any):
        for event in self._events:
            yield event


def _make_agent(events: list[dict[str, Any]], thread_id: str = "t-log") -> StrandsAgent:
    template = _FakeStrandsAgent([])
    agent = StrandsAgent(template, name="test-agent", config=StrandsAgentConfig())
    agent._agents_by_thread[thread_id] = _FakeStrandsAgent(events)
    return agent


def _make_input(thread_id: str = "t-log") -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id="r-log",
        state={},
        messages=[UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def test_debug_disabled_does_not_repr_stream_events():
    """With DEBUG disabled, StrandsAgent.run must not call repr() on events."""
    result_spy = _ReprSpy("graph-result")
    sig_spy = _ReprSpy("sig")
    raw_spy = _ReprSpy("raw-extra")

    events_to_stream: list[dict[str, Any]] = [
        {"data": "hello"},
        {"reasoning": True, "reasoning_signature": sig_spy},
        {"custom_unmapped": {"ok": 1}, "ignored_note": raw_spy},
        {"result": result_spy},
    ]

    agent = _make_agent(events_to_stream)
    agent_logger = logging.getLogger("ag_ui_strands.agent")
    previous_level = agent_logger.level
    agent_logger.setLevel(logging.INFO)
    try:
        emitted = [e async for e in agent.run(_make_input())]
    finally:
        agent_logger.setLevel(previous_level)

    assert any(e.type == EventType.RUN_FINISHED for e in emitted)
    assert result_spy.repr_calls == 0, "event['result'] was repr()'d despite DEBUG disabled"
    assert sig_spy.repr_calls == 0 and sig_spy.str_calls == 0, (
        "reasoning_signature was formatted despite DEBUG disabled"
    )


async def test_debug_enabled_truncates_large_event_repr(caplog: pytest.LogCaptureFixture):
    """With DEBUG enabled, large events and RAW payloads are truncated."""
    huge_list = [f"item-{i}" for i in range(5000)]
    events_to_stream: list[dict[str, Any]] = [
        {"data": "ok"},
        {"custom_unmapped": {"items": huge_list}},
        {"result": {"payload": huge_list}},
    ]

    agent = _make_agent(events_to_stream)
    with caplog.at_level(logging.DEBUG, logger="ag_ui_strands.agent"):
        emitted = [e async for e in agent.run(_make_input())]

    assert any(e.type == EventType.RUN_FINISHED for e in emitted)
    received_logs = [
        r.getMessage() for r in caplog.records if r.getMessage().startswith("Received event:")
    ]
    assert len(received_logs) == 3
    for large_log in received_logs[1:]:
        assert "..." in large_log
        assert len(large_log) < 500

    raw_logs = [
        r.getMessage()
        for r in caplog.records
        if r.getMessage().startswith("Unmapped Strands event forwarded as RAW")
    ]
    assert len(raw_logs) == 1
    assert "..." in raw_logs[0]
    assert len(raw_logs[0]) < 500


async def test_debug_enabled_avoids_custom_repr_and_full_bytes_formatting(
    caplog: pytest.LogCaptureFixture,
):
    """With DEBUG enabled, opaque objects are not repr()'d and large bytes are bounded."""
    result_spy = _ReprSpy("graph-result")
    tool_spy = _ReprSpy("tool-payload")
    huge_bytes = b"\xab" * (2 * 1024 * 1024)

    events_to_stream: list[dict[str, Any]] = [
        {"reasoning": True, "reasoningRedactedContent": huge_bytes},
        {"custom_unmapped": {"payload": tool_spy}},
        {"result": result_spy},
    ]

    agent = _make_agent(events_to_stream)
    with caplog.at_level(logging.DEBUG, logger="ag_ui_strands.agent"):
        emitted = [e async for e in agent.run(_make_input())]

    assert any(e.type == EventType.RUN_FINISHED for e in emitted)
    assert result_spy.repr_calls == 0 and result_spy.str_calls == 0
    assert tool_spy.repr_calls == 0 and tool_spy.str_calls == 0

    received_logs = [
        r.getMessage() for r in caplog.records if r.getMessage().startswith("Received event:")
    ]
    assert len(received_logs) == 3
    assert "<bytes len=2097152" in received_logs[0]
    assert "..." in received_logs[0]
    assert len(received_logs[0]) < 500
    assert "<_ReprSpy>" in received_logs[1]
    assert "<_ReprSpy>" in received_logs[2]
