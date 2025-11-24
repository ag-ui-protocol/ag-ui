#!/usr/bin/env python
"""Integration test: mixed partials with non-LRO calls before final LRO.

Scenario:
- Stream text in partial chunks
- Mid-stream, a non-LRO function call appears (should close text and emit tool events)
- Finally, an LRO function call arrives (should close any open text and emit LRO tool events)

Asserts order, deduplication, and correct tool ids.
"""

import pytest
from unittest.mock import MagicMock, AsyncMock, Mock, patch

from ag_ui.core import (
    RunAgentInput, UserMessage
)
from ag_ui_adk import ADKAgent


@pytest.fixture
def adk_agent_instance():
    from google.adk.agents import Agent
    mock_agent = Mock(spec=Agent)
    mock_agent.name = "test_agent"
    return ADKAgent(adk_agent=mock_agent, app_name="test_app", user_id="test_user")


@pytest.mark.asyncio
async def test_mixed_partials_non_lro_then_lro(adk_agent_instance):
    # Helper to create partial text events
    def mk_partial(text):
        e = MagicMock()
        e.author = "assistant"
        e.content = MagicMock(); e.content.parts = [MagicMock(text=text)]
        e.partial = True
        e.turn_complete = False
        e.is_final_response = lambda: False
        # No function responses in these partials
        e.get_function_responses = lambda: []
        e.get_function_calls = lambda: []
        return e

    # First partial text only
    evt1 = mk_partial("Hello")

    # Second partial: text + non-LRO function call
    normal_id = "normal-999"
    normal_func = MagicMock(); normal_func.id = normal_id; normal_func.name = "regular_tool"; normal_func.args = {"b": 2}
    evt2 = mk_partial(" world")
    evt2.get_function_calls = lambda: [normal_func]
    evt2.long_running_tool_ids = []

    # Final: LRO function call
    lro_id = "lro-777"
    lro_func = MagicMock(); lro_func.id = lro_id; lro_func.name = "long_running_tool"; lro_func.args = {"v": 1}
    lro_part = MagicMock(); lro_part.function_call = lro_func

    evt3 = MagicMock()
    evt3.author = "assistant"
    evt3.content = MagicMock(); evt3.content.parts = [lro_part]
    evt3.partial = False
    evt3.turn_complete = True
    evt3.is_final_response = lambda: True
    evt3.get_function_calls = lambda: []
    evt3.get_function_responses = lambda: []
    evt3.long_running_tool_ids = [lro_id]

    async def mock_run_async(*args, **kwargs):
        yield evt1
        yield evt2
        yield evt3

    mock_runner = AsyncMock(); mock_runner.run_async = mock_run_async

    sample_input = RunAgentInput(
        thread_id="thread_mixed",
        run_id="run_mixed",
        messages=[UserMessage(id="u1", role="user", content="go")],
        tools=[], context=[], state={}, forwarded_props={},
    )

    with patch.object(adk_agent_instance, "_create_runner", return_value=mock_runner):
        events = []
        async for e in adk_agent_instance.run(sample_input):
            events.append(e)

    types = [str(ev.type).split(".")[-1] for ev in events]

    # Expect at least one START and 2 CONTENTs from streaming
    assert types.count("TEXT_MESSAGE_START") == 1
    assert types.count("TEXT_MESSAGE_CONTENT") >= 2

    # Non-LRO tool call should appear exactly once
    normal_starts = [i for i, ev in enumerate(events) if str(ev.type).endswith("TOOL_CALL_START") and getattr(ev, "tool_call_id", None) == normal_id]
    normal_args = [i for i, ev in enumerate(events) if str(ev.type).endswith("TOOL_CALL_ARGS") and getattr(ev, "tool_call_id", None) == normal_id]
    normal_ends = [i for i, ev in enumerate(events) if str(ev.type).endswith("TOOL_CALL_END") and getattr(ev, "tool_call_id", None) == normal_id]
    assert len(normal_starts) == len(normal_args) == len(normal_ends) == 1

    # Ensure a TEXT_MESSAGE_END precedes the normal tool start
    text_ends = [i for i, t in enumerate(types) if t == "TEXT_MESSAGE_END"]
    assert len(text_ends) >= 1
    assert text_ends[-1] < normal_starts[0], "TEXT_MESSAGE_END must precede first non-LRO TOOL_CALL_START"

    # LRO tool call should appear exactly once and after the non-LRO
    lro_starts = [i for i, ev in enumerate(events) if str(ev.type).endswith("TOOL_CALL_START") and getattr(ev, "tool_call_id", None) == lro_id]
    lro_args = [i for i, ev in enumerate(events) if str(ev.type).endswith("TOOL_CALL_ARGS") and getattr(ev, "tool_call_id", None) == lro_id]
    lro_ends = [i for i, ev in enumerate(events) if str(ev.type).endswith("TOOL_CALL_END") and getattr(ev, "tool_call_id", None) == lro_id]
    assert len(lro_starts) == len(lro_args) == len(lro_ends) == 1
    assert lro_starts[0] > normal_starts[0]

