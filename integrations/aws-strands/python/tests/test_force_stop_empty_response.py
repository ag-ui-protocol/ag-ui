"""Tests for force_stop event handling when no content has been emitted.

When Bedrock raises a ValidationException (input too long), Strands converts
it to a force_stop event.  The adapter must emit a human-readable error
message rather than silently producing RUN_STARTED → RUN_FINISHED with no
content in between.
"""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock
from ag_ui.core import EventType

from ag_ui_strands.agent import StrandsAgent


class MockStrandsAgent:
    def __init__(self, events):
        self.events = events
        self.model = MagicMock()
        self.system_prompt = "test"
        self.tool_registry = MagicMock()
        self.tool_registry.registry = {}
        self.record_direct_tool_call = True

    async def stream_async(self, message):
        for event in self.events:
            yield event


def make_input_data(messages=None, state=None, tools=None):
    input_data = MagicMock()
    input_data.thread_id = "test-thread"
    input_data.run_id = "test-run"
    input_data.state = state or {}
    input_data.messages = messages or []
    input_data.tools = tools or []
    return input_data


def create_agent(mock_events):
    mock_base = MockStrandsAgent(mock_events)
    agent = StrandsAgent(mock_base, name="test", description="test")
    agent._agents_by_thread["test-thread"] = MockStrandsAgent(mock_events)
    return agent


@pytest.mark.asyncio
async def test_force_stop_with_no_content_emits_error_message():
    """force_stop before any text emits a TEXT_MESSAGE with an error."""
    agent = create_agent([{"force_stop": True}])
    events = [e async for e in agent.run(make_input_data())]
    types = [e.type for e in events]

    assert EventType.TEXT_MESSAGE_START in types
    assert EventType.TEXT_MESSAGE_CONTENT in types
    assert EventType.TEXT_MESSAGE_END in types
    assert EventType.RUN_FINISHED in types

    # Error message should appear before RUN_FINISHED
    assert types.index(EventType.TEXT_MESSAGE_START) < types.index(EventType.RUN_FINISHED)


@pytest.mark.asyncio
async def test_force_stop_with_no_content_error_text_mentions_history():
    """Generic force_stop (bool True) produces the 'history too long' hint."""
    agent = create_agent([{"force_stop": True}])
    events = [e async for e in agent.run(make_input_data())]

    content_events = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
    assert content_events, "Expected at least one TEXT_MESSAGE_CONTENT event"
    assert "history" in content_events[0].delta.lower() or "respond" in content_events[0].delta.lower()


@pytest.mark.asyncio
async def test_force_stop_with_string_reason_includes_reason():
    """force_stop with a string reason includes that reason in the message."""
    reason = "Input is too long for requested model"
    agent = create_agent([{"force_stop": reason}])
    events = [e async for e in agent.run(make_input_data())]

    content_events = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
    assert content_events
    assert reason in content_events[0].delta


@pytest.mark.asyncio
async def test_force_stop_after_content_does_not_add_error():
    """If text was already streaming, force_stop should NOT inject an extra message."""
    agent = create_agent([
        {"data": "Here is my answer."},
        {"force_stop": True},
    ])
    events = [e async for e in agent.run(make_input_data())]
    types = [e.type for e in events]

    # Only one TEXT_MESSAGE_START (the real one, not an injected error)
    assert types.count(EventType.TEXT_MESSAGE_START) == 1

    content_events = [e for e in events if e.type == EventType.TEXT_MESSAGE_CONTENT]
    assert any("Here is my answer." in e.delta for e in content_events)


@pytest.mark.asyncio
async def test_complete_event_with_no_content_does_not_emit_error():
    """complete (normal finish) with no text should NOT inject an error message.

    A run that calls only tools and finishes cleanly via 'complete' is valid;
    the no-content error path is only for force_stop (abnormal termination).
    """
    agent = create_agent([{"complete": True}])
    events = [e async for e in agent.run(make_input_data())]
    types = [e.type for e in events]

    assert EventType.TEXT_MESSAGE_START not in types
