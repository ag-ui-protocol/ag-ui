#!/usr/bin/env python
"""Test: Non-streaming mode with text + LRO client tool call.

This test reproduces GitHub Issue #906 where text content was not
emitted when streaming mode is disabled and a response includes
both text and a client function call (LRO).

Expected Event Sequence:
- RUN_STARTED
- TEXT_MESSAGE_START
- TEXT_MESSAGE_CONTENT
- TEXT_MESSAGE_END
- TOOL_CALL_START
- TOOL_CALL_ARGS
- TOOL_CALL_END
- RUN_FINISHED
"""

import pytest
from unittest.mock import MagicMock, AsyncMock, Mock, patch

from ag_ui.core import RunAgentInput, UserMessage
from ag_ui_adk import ADKAgent


@pytest.fixture
def adk_agent_instance():
    from google.adk.agents import Agent
    mock_agent = Mock(spec=Agent)
    mock_agent.name = "test_agent"
    return ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")


@pytest.mark.asyncio
async def test_non_streaming_text_with_lro_tool_call(adk_agent_instance):
    """Test that text content is emitted before LRO tool call in non-streaming mode.

    This is the main test for GitHub Issue #906.
    """

    # Create a non-streaming event with text + LRO function call
    lro_tool_id = "lro-client-tool-123"
    lro_func = MagicMock()
    lro_func.id = lro_tool_id
    lro_func.name = "client_search_tool"
    lro_func.args = {"query": "test search"}

    # Create content parts: text part + function call part
    text_part = MagicMock()
    text_part.text = "I'll search for that information."
    text_part.function_call = None  # This is a text part

    func_part = MagicMock()
    func_part.text = None  # This is a function call part
    func_part.function_call = lro_func

    # Create the non-streaming event
    evt = MagicMock()
    evt.author = "assistant"
    evt.content = MagicMock()
    evt.content.parts = [text_part, func_part]
    evt.partial = False  # Non-streaming
    evt.turn_complete = True
    evt.is_final_response = lambda: True  # Final response
    evt.get_function_calls = lambda: [lro_func]
    evt.get_function_responses = lambda: []
    evt.long_running_tool_ids = [lro_tool_id]  # Marks this as LRO

    async def mock_run_async(*args, **kwargs):
        yield evt

    mock_runner = AsyncMock()
    mock_runner.run_async = mock_run_async

    sample_input = RunAgentInput(
        thread_id="thread_non_streaming",
        run_id="run_non_streaming",
        messages=[UserMessage(id="u1", role="user", content="Search for test")],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    )

    with patch.object(adk_agent_instance, "_create_runner", return_value=mock_runner):
        events = []
        async for e in adk_agent_instance.run(sample_input):
            events.append(e)

    # Extract event types for analysis
    types = [str(ev.type).split(".")[-1] for ev in events]

    print(f"Event sequence: {types}")

    # Verify TEXT_MESSAGE events are present
    assert "TEXT_MESSAGE_START" in types, f"Missing TEXT_MESSAGE_START. Got: {types}"
    assert "TEXT_MESSAGE_CONTENT" in types, f"Missing TEXT_MESSAGE_CONTENT. Got: {types}"
    assert "TEXT_MESSAGE_END" in types, f"Missing TEXT_MESSAGE_END. Got: {types}"

    # Verify TOOL_CALL events are present
    assert "TOOL_CALL_START" in types, f"Missing TOOL_CALL_START. Got: {types}"
    assert "TOOL_CALL_END" in types, f"Missing TOOL_CALL_END. Got: {types}"

    # Verify correct order: text events BEFORE tool events
    text_end_idx = types.index("TEXT_MESSAGE_END")
    tool_start_idx = types.index("TOOL_CALL_START")
    assert text_end_idx < tool_start_idx, (
        f"TEXT_MESSAGE_END (index {text_end_idx}) must come before "
        f"TOOL_CALL_START (index {tool_start_idx}). Event sequence: {types}"
    )

    # Verify the text content
    content_events = [e for e in events if str(e.type).endswith("TEXT_MESSAGE_CONTENT")]
    assert len(content_events) >= 1
    combined_text = "".join(e.delta for e in content_events)
    assert "I'll search for that information" in combined_text

    # Verify the tool call ID
    tool_start_events = [e for e in events if str(e.type).endswith("TOOL_CALL_START")]
    assert len(tool_start_events) == 1
    assert tool_start_events[0].tool_call_id == lro_tool_id


@pytest.mark.asyncio
async def test_non_streaming_lro_tool_without_text(adk_agent_instance):
    """Test that LRO tool calls work correctly when there's no text content."""

    lro_tool_id = "lro-tool-456"
    lro_func = MagicMock()
    lro_func.id = lro_tool_id
    lro_func.name = "silent_tool"
    lro_func.args = {}

    func_part = MagicMock()
    func_part.text = None
    func_part.function_call = lro_func

    evt = MagicMock()
    evt.author = "assistant"
    evt.content = MagicMock()
    evt.content.parts = [func_part]  # Only function call, no text
    evt.partial = False
    evt.turn_complete = True
    evt.is_final_response = lambda: True
    evt.get_function_calls = lambda: [lro_func]
    evt.get_function_responses = lambda: []
    evt.long_running_tool_ids = [lro_tool_id]

    async def mock_run_async(*args, **kwargs):
        yield evt

    mock_runner = AsyncMock()
    mock_runner.run_async = mock_run_async

    sample_input = RunAgentInput(
        thread_id="thread_no_text",
        run_id="run_no_text",
        messages=[UserMessage(id="u1", role="user", content="Do silent action")],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    )

    with patch.object(adk_agent_instance, "_create_runner", return_value=mock_runner):
        events = []
        async for e in adk_agent_instance.run(sample_input):
            events.append(e)

    types = [str(ev.type).split(".")[-1] for ev in events]

    print(f"Event sequence (no text): {types}")

    # Should NOT have text events (no text content)
    assert "TEXT_MESSAGE_START" not in types, f"Unexpected TEXT_MESSAGE_START. Got: {types}"
    assert "TEXT_MESSAGE_CONTENT" not in types, f"Unexpected TEXT_MESSAGE_CONTENT. Got: {types}"

    # Should have tool events
    assert "TOOL_CALL_START" in types, f"Missing TOOL_CALL_START. Got: {types}"
    assert "TOOL_CALL_END" in types, f"Missing TOOL_CALL_END. Got: {types}"


@pytest.mark.asyncio
async def test_non_streaming_text_only_no_lro(adk_agent_instance):
    """Test that non-streaming text-only responses still work correctly."""

    text_part = MagicMock()
    text_part.text = "Here is your answer."
    text_part.function_call = None

    evt = MagicMock()
    evt.author = "assistant"
    evt.content = MagicMock()
    evt.content.parts = [text_part]  # Only text, no function call
    evt.partial = False
    evt.turn_complete = True
    evt.is_final_response = lambda: True
    evt.get_function_calls = lambda: []
    evt.get_function_responses = lambda: []
    evt.long_running_tool_ids = []

    async def mock_run_async(*args, **kwargs):
        yield evt

    mock_runner = AsyncMock()
    mock_runner.run_async = mock_run_async

    sample_input = RunAgentInput(
        thread_id="thread_text_only",
        run_id="run_text_only",
        messages=[UserMessage(id="u1", role="user", content="Answer me")],
        tools=[],
        context=[],
        state={},
        forwarded_props={},
    )

    with patch.object(adk_agent_instance, "_create_runner", return_value=mock_runner):
        events = []
        async for e in adk_agent_instance.run(sample_input):
            events.append(e)

    types = [str(ev.type).split(".")[-1] for ev in events]

    print(f"Event sequence (text only): {types}")

    # Should have text events
    assert "TEXT_MESSAGE_START" in types, f"Missing TEXT_MESSAGE_START. Got: {types}"
    assert "TEXT_MESSAGE_CONTENT" in types, f"Missing TEXT_MESSAGE_CONTENT. Got: {types}"
    assert "TEXT_MESSAGE_END" in types, f"Missing TEXT_MESSAGE_END. Got: {types}"

    # Should NOT have tool events
    assert "TOOL_CALL_START" not in types, f"Unexpected TOOL_CALL_START. Got: {types}"
