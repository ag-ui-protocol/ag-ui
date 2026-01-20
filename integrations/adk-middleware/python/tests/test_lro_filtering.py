#!/usr/bin/env python
"""Tests for LRO-aware routing and translator filtering.

These tests verify that:
- EventTranslator.translate skips long-running tool calls and only emits non-LRO calls
- translate_lro_function_calls emits events only for long-running tool calls
"""

import asyncio
from unittest.mock import MagicMock

from ag_ui.core import EventType
from ag_ui_adk import EventTranslator


async def test_translate_skips_lro_function_calls():
    """Ensure non-LRO tool calls are emitted and LRO calls are skipped in translate."""
    translator = EventTranslator()

    # Prepare mock ADK event
    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = False  # Not a streaming preview (required for function call processing)
    adk_event.content = MagicMock()
    adk_event.content.parts = []  # no text

    # Two function calls, one is long-running
    lro_id = "tool-call-lro-1"
    normal_id = "tool-call-normal-2"

    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "long_running_tool"
    lro_call.args = {"x": 1}

    normal_call = MagicMock()
    normal_call.id = normal_id
    normal_call.name = "regular_tool"
    normal_call.args = {"y": 2}

    adk_event.get_function_calls = lambda: [lro_call, normal_call]
    # Mark the long-running call id on the event
    adk_event.long_running_tool_ids = [lro_id]

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    # We expect only the non-LRO tool call events to be emitted
    # Sequence: TOOL_CALL_START(normal), TOOL_CALL_ARGS(normal), TOOL_CALL_END(normal)
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert event_types.count("TOOL_CALL_START") == 1
    assert event_types.count("TOOL_CALL_ARGS") == 1
    assert event_types.count("TOOL_CALL_END") == 1

    # Ensure the emitted tool_call_id is the normal one
    ids = set(getattr(ev, 'tool_call_id', None) for ev in events)
    assert normal_id in ids
    assert lro_id not in ids


async def test_translate_lro_function_calls_only_emits_lro():
    """Ensure translate_lro_function_calls emits only for long-running calls."""
    translator = EventTranslator()

    # Prepare mock ADK event with content parts containing function calls
    lro_id = "tool-call-lro-3"
    normal_id = "tool-call-normal-4"

    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "long_running_tool"
    lro_call.args = {"a": 123}

    normal_call = MagicMock()
    normal_call.id = normal_id
    normal_call.name = "regular_tool"
    normal_call.args = {"b": 456}

    # Build parts with both calls
    lro_part = MagicMock()
    lro_part.function_call = lro_call
    normal_part = MagicMock()
    normal_part.function_call = normal_call

    adk_event = MagicMock()
    adk_event.content = MagicMock()
    adk_event.content.parts = [lro_part, normal_part]
    adk_event.long_running_tool_ids = [lro_id]

    events = []
    async for e in translator.translate_lro_function_calls(adk_event):
        events.append(e)

    # Expect only the LRO call events
    # Sequence: TOOL_CALL_START(lro), TOOL_CALL_ARGS(lro), TOOL_CALL_END(lro)
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert event_types == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]
    for ev in events:
        assert getattr(ev, 'tool_call_id', None) == lro_id


async def test_translate_skips_function_calls_from_partial_events():
    """Ensure function calls from partial events are skipped.

    With PROGRESSIVE_SSE_STREAMING (enabled by default in google-adk >= 1.22.0),
    partial events contain streaming "previews" of function calls that should not
    be translated to TOOL_CALL events. Only confirmed function calls (partial=False)
    should be emitted.

    See: https://github.com/ag-ui-protocol/ag-ui/issues/968
    """
    translator = EventTranslator()

    # Prepare mock ADK event with partial=True (streaming preview)
    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True  # This is a streaming preview
    adk_event.content = MagicMock()
    adk_event.content.parts = []  # no text

    # Function call in a partial event should be skipped
    func_call = MagicMock()
    func_call.id = "preview-tool-call-1"
    func_call.name = "some_tool"
    func_call.args = {"x": 1}

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    # No tool call events should be emitted for partial events
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert event_types.count("TOOL_CALL_START") == 0, \
        f"Expected no TOOL_CALL_START from partial event, got {event_types}"
    assert event_types.count("TOOL_CALL_ARGS") == 0
    assert event_types.count("TOOL_CALL_END") == 0


async def test_translate_emits_function_calls_from_confirmed_events():
    """Ensure function calls from confirmed (non-partial) events are emitted.

    This is the counterpart to test_translate_skips_function_calls_from_partial_events.
    When partial=False, function calls should be processed normally.
    """
    translator = EventTranslator()

    # Prepare mock ADK event with partial=False (confirmed)
    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = False  # This is a confirmed event
    adk_event.content = MagicMock()
    adk_event.content.parts = []  # no text

    # Function call in a confirmed event should be emitted
    func_call = MagicMock()
    func_call.id = "confirmed-tool-call-1"
    func_call.name = "some_tool"
    func_call.args = {"x": 1}

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    # Tool call events should be emitted for confirmed events
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert event_types.count("TOOL_CALL_START") == 1, \
        f"Expected 1 TOOL_CALL_START from confirmed event, got {event_types}"
    assert event_types.count("TOOL_CALL_ARGS") == 1
    assert event_types.count("TOOL_CALL_END") == 1

    # Verify the correct tool call ID was emitted
    tool_call_ids = [getattr(ev, 'tool_call_id', None) for ev in events if hasattr(ev, 'tool_call_id')]
    assert "confirmed-tool-call-1" in tool_call_ids


async def test_translate_handles_missing_partial_attribute():
    """Ensure backwards compatibility when partial attribute is missing.

    Older versions of google-adk may not have the partial attribute on events.
    In this case, we should default to processing the function calls (partial=False behavior).
    """
    translator = EventTranslator()

    # Prepare mock ADK event WITHOUT partial attribute (simulating older google-adk)
    adk_event = MagicMock(spec=['author', 'content', 'get_function_calls', 'long_running_tool_ids'])
    adk_event.author = "assistant"
    # Note: partial is NOT set - spec prevents MagicMock from auto-creating it
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = "legacy-tool-call-1"
    func_call.name = "legacy_tool"
    func_call.args = {"y": 2}

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    # Tool call events should be emitted (backwards compatible behavior)
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert event_types.count("TOOL_CALL_START") == 1, \
        f"Expected 1 TOOL_CALL_START for backwards compatibility, got {event_types}"


if __name__ == "__main__":
    asyncio.run(test_translate_skips_lro_function_calls())
    asyncio.run(test_translate_lro_function_calls_only_emits_lro())
    asyncio.run(test_translate_skips_function_calls_from_partial_events())
    asyncio.run(test_translate_emits_function_calls_from_confirmed_events())
    asyncio.run(test_translate_handles_missing_partial_attribute())
    print("\n✅ LRO and partial filtering tests ran to completion")

