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


if __name__ == "__main__":
    asyncio.run(test_translate_skips_lro_function_calls())
    asyncio.run(test_translate_lro_function_calls_only_emits_lro())
    print("\n✅ LRO filtering tests ran to completion")

