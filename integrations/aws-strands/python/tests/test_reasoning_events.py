"""Tests for reasoning/thinking events in StrandsAgent."""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch
from ag_ui.core import EventType


class MockStrandsAgent:
    """Mock Strands agent that yields predefined events."""

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
    """Create a mock RunAgentInput."""
    input_data = MagicMock()
    input_data.thread_id = "test-thread"
    input_data.run_id = "test-run"
    input_data.state = state or {}
    input_data.messages = messages or []
    input_data.tools = tools or []
    return input_data


def create_agent_with_mock_events(mock_events, config=None):
    """Create a StrandsAgent with mocked event stream."""
    from ag_ui_strands.agent import StrandsAgent

    # Create a mock base agent to extract config from
    mock_base = MockStrandsAgent(mock_events)
    agent = StrandsAgent(mock_base, name="test", description="test", config=config)

    # Pre-populate the _agents_by_thread with our mock that yields the events
    agent._agents_by_thread["test-thread"] = MockStrandsAgent(mock_events)

    return agent


@pytest.mark.asyncio
async def test_reasoning_events_emitted():
    """Test that reasoning events are properly emitted."""
    mock_events = [
        {"reasoningText": "Let me think...", "reasoning": True},
        {"reasoningText": " about this problem.", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"data": "Here's my answer."},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]

    # Verify reasoning events are emitted (thinking events are deprecated)
    assert EventType.REASONING_START in event_types
    assert EventType.REASONING_MESSAGE_START in event_types
    assert EventType.REASONING_MESSAGE_CONTENT in event_types
    assert EventType.REASONING_MESSAGE_END in event_types
    assert EventType.REASONING_END in event_types


@pytest.mark.asyncio
async def test_reasoning_content_streamed():
    """Test that reasoning content is properly streamed."""
    mock_events = [
        {"reasoningText": "Chunk 1", "reasoning": True},
        {"reasoningText": "Chunk 2", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    # Find reasoning content events
    reasoning_content = [
        e for e in events if e.type == EventType.REASONING_MESSAGE_CONTENT
    ]
    assert len(reasoning_content) == 2
    assert reasoning_content[0].delta == "Chunk 1"
    assert reasoning_content[1].delta == "Chunk 2"


@pytest.mark.asyncio
async def test_encrypted_reasoning_events():
    """Test that encrypted reasoning content is properly handled."""
    mock_events = [
        {"reasoningRedactedContent": b"encrypted_content", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]
    assert EventType.REASONING_ENCRYPTED_VALUE in event_types

    # Verify encrypted value event has proper structure
    encrypted_event = next(
        e for e in events if e.type == EventType.REASONING_ENCRYPTED_VALUE
    )
    assert encrypted_event.subtype == "message"
    assert encrypted_event.entity_id is not None
    # base64 encoded "encrypted_content" = "ZW5jcnlwdGVkX2NvbnRlbnQ="
    assert encrypted_event.encrypted_value == "ZW5jcnlwdGVkX2NvbnRlbnQ="


@pytest.mark.asyncio
async def test_step_events_for_multiagent_start():
    """Test STEP_STARTED events are emitted for multi-agent node start."""
    mock_events = [
        {"type": "multiagent_node_start", "node_id": "agent_1", "node_type": "agent"},
        {"data": "Processing..."},
        {"type": "multiagent_node_stop", "node_id": "agent_1", "node_type": "agent"},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]
    assert EventType.STEP_STARTED in event_types
    assert EventType.STEP_FINISHED in event_types

    # Verify step names
    step_started = next(e for e in events if e.type == EventType.STEP_STARTED)
    assert step_started.step_name == "agent:agent_1"

    step_finished = next(e for e in events if e.type == EventType.STEP_FINISHED)
    assert step_finished.step_name == "agent:agent_1"


@pytest.mark.asyncio
async def test_multiagent_handoff_custom_event():
    """Test multi-agent handoff is emitted as CUSTOM event."""
    mock_events = [
        {
            "type": "multiagent_handoff",
            "from_node_ids": ["agent_1"],
            "to_node_ids": ["agent_2"],
            "message": "Passing control",
        },
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    custom_events = [e for e in events if e.type == EventType.CUSTOM]
    handoff_events = [e for e in custom_events if e.name == "MultiAgentHandoff"]

    assert len(handoff_events) == 1
    assert handoff_events[0].value["from_nodes"] == ["agent_1"]
    assert handoff_events[0].value["to_nodes"] == ["agent_2"]
    assert handoff_events[0].value["message"] == "Passing control"


@pytest.mark.asyncio
async def test_reasoning_closed_before_text():
    """Test that reasoning events are closed before text streaming starts."""
    mock_events = [
        {"reasoningText": "Thinking...", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"data": "Here's my response."},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]

    # Find indices to verify ordering
    reasoning_end_idx = event_types.index(EventType.REASONING_END)
    text_start_idx = event_types.index(EventType.TEXT_MESSAGE_START)

    # Reasoning should end before text starts
    assert reasoning_end_idx < text_start_idx


# =============================================================================
# Edge Cases / Unhappy Paths
# =============================================================================


@pytest.mark.asyncio
async def test_empty_reasoning_text_no_content_emitted():
    """Test that empty reasoning text starts reasoning but emits no content."""
    mock_events = [
        {"reasoningText": "", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    # Reasoning should NOT start because empty string is falsy after the check
    # The implementation checks `if reasoning_text:` before emitting content
    # But it also checks this AFTER starting reasoning, so we need to verify behavior
    reasoning_content = [
        e for e in events if e.type == EventType.REASONING_MESSAGE_CONTENT
    ]

    # Empty string should not emit content events
    assert len(reasoning_content) == 0


@pytest.mark.asyncio
async def test_reasoning_flag_false_no_events():
    """Test that reasoning=False does not emit reasoning events."""
    mock_events = [
        {"reasoningText": "This should not appear", "reasoning": False},
        {"data": "Normal response"},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]

    # No reasoning events should be emitted
    assert EventType.REASONING_START not in event_types
    assert EventType.REASONING_MESSAGE_CONTENT not in event_types

    # But text should still work
    assert EventType.TEXT_MESSAGE_CONTENT in event_types


@pytest.mark.asyncio
async def test_missing_reasoning_flag_no_events():
    """Test that missing reasoning flag does not emit reasoning events."""
    mock_events = [
        {"reasoningText": "This should not appear"},  # No "reasoning" key
        {"data": "Normal response"},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]

    # No reasoning events should be emitted
    assert EventType.REASONING_START not in event_types

    # Text should still work
    assert EventType.TEXT_MESSAGE_CONTENT in event_types


@pytest.mark.asyncio
async def test_non_bytes_encrypted_content_fallback():
    """Test that non-bytes encrypted content uses str() fallback."""
    mock_events = [
        {"reasoningRedactedContent": "string_content_not_bytes", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]
    assert EventType.REASONING_ENCRYPTED_VALUE in event_types

    encrypted_event = next(
        e for e in events if e.type == EventType.REASONING_ENCRYPTED_VALUE
    )
    # String content should be passed through as-is via str()
    assert encrypted_event.encrypted_value == "string_content_not_bytes"


@pytest.mark.asyncio
async def test_multiple_reasoning_blocks():
    """Test multiple separate reasoning phases in one run."""
    mock_events = [
        # First reasoning block
        {"reasoningText": "First thought", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"data": "First response"},
        # Second reasoning block
        {"reasoningText": "Second thought", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"data": "Second response"},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    # Count reasoning start events - should have 2 separate reasoning phases
    reasoning_starts = [e for e in events if e.type == EventType.REASONING_START]
    assert len(reasoning_starts) == 2

    # Verify content from both blocks
    reasoning_content = [
        e for e in events if e.type == EventType.REASONING_MESSAGE_CONTENT
    ]
    assert len(reasoning_content) == 2
    assert reasoning_content[0].delta == "First thought"
    assert reasoning_content[1].delta == "Second thought"


@pytest.mark.asyncio
async def test_reasoning_event_field_values():
    """Test that reasoning events have correct field values."""
    mock_events = [
        {"reasoningText": "Test content", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    # Verify ReasoningMessageStartEvent has role
    reasoning_msg_start = next(
        e for e in events if e.type == EventType.REASONING_MESSAGE_START
    )
    assert reasoning_msg_start.role == "reasoning"

    # Verify message_id consistency across reasoning events
    reasoning_start = next(e for e in events if e.type == EventType.REASONING_START)
    reasoning_content = next(
        e for e in events if e.type == EventType.REASONING_MESSAGE_CONTENT
    )
    reasoning_msg_end = next(
        e for e in events if e.type == EventType.REASONING_MESSAGE_END
    )

    assert reasoning_start.message_id == reasoning_msg_start.message_id
    assert reasoning_start.message_id == reasoning_content.message_id
    assert reasoning_start.message_id == reasoning_msg_end.message_id


@pytest.mark.asyncio
async def test_reasoning_only_no_text_response():
    """Test reasoning events without any text response."""
    mock_events = [
        {"reasoningText": "Just thinking", "reasoning": True},
        {"event": {"contentBlockStop": {}}},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]

    # Reasoning events should be present
    assert EventType.REASONING_START in event_types
    assert EventType.REASONING_END in event_types

    # No text message events
    assert EventType.TEXT_MESSAGE_START not in event_types
    assert EventType.TEXT_MESSAGE_CONTENT not in event_types


@pytest.mark.asyncio
async def test_text_only_no_reasoning():
    """Test text response without any reasoning events."""
    mock_events = [
        {"data": "Direct response without thinking"},
        {"complete": True},
    ]

    agent = create_agent_with_mock_events(mock_events)

    events = []
    input_data = make_input_data()

    async for event in agent.run(input_data):
        events.append(event)

    event_types = [e.type for e in events]

    # No reasoning events
    assert EventType.REASONING_START not in event_types

    # Text events should be present
    assert EventType.TEXT_MESSAGE_START in event_types
    assert EventType.TEXT_MESSAGE_CONTENT in event_types
    assert EventType.TEXT_MESSAGE_END in event_types
