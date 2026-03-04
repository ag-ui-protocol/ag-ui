"""Tests for streaming function call arguments (Mode A, google-adk >= 1.24.0).

These tests verify the EventTranslator correctly handles streaming function call
chunks from Gemini 3+ models when streaming_function_call_arguments=True.
"""

import json
import pytest
from unittest.mock import MagicMock

from ag_ui.core import EventType
from ag_ui_adk import EventTranslator, ADKAgent
from ag_ui_adk.config import PredictStateMapping


def _event_types(events):
    """Extract event type names from a list of events."""
    return [str(ev.type).split('.')[-1] for ev in events]


def _make_adk_event(
    func_calls=None,
    partial=False,
    author="assistant",
    lro_ids=None,
):
    """Create a mock ADK event with function calls."""
    event = MagicMock()
    event.author = author
    event.partial = partial
    event.content = MagicMock()
    event.content.parts = []
    event.get_function_calls = MagicMock(return_value=func_calls or [])
    event.long_running_tool_ids = lro_ids or []
    # get_function_responses should return empty by default
    event.get_function_responses = MagicMock(return_value=[])
    # Prevent MagicMock auto-creating truthy attributes for state/custom handlers
    event.actions = None
    event.custom_data = None
    return event


def _make_func_call(name=None, args=None, partial_args=None, will_continue=None, fc_id=None):
    """Create a mock FunctionCall."""
    fc = MagicMock()
    fc.name = name
    fc.id = fc_id or f"adk-{id(fc)}"
    fc.args = args
    fc.partial_args = partial_args
    fc.will_continue = will_continue
    return fc


def _make_partial_arg(json_path, string_value):
    """Create a mock PartialArg."""
    pa = MagicMock()
    pa.json_path = json_path
    pa.string_value = string_value
    return pa


async def _collect_events(translator, adk_event, thread_id="thread", run_id="run"):
    """Collect all events from a translator.translate() call."""
    events = []
    async for e in translator.translate(adk_event, thread_id, run_id):
        events.append(e)
    return events


# ============================================================================
# First chunk tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_first_chunk_emits_start():
    """First chunk with name + will_continue=True emits TOOL_CALL_START."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    fc = _make_func_call(name="write_document", will_continue=True)
    adk_event = _make_adk_event(func_calls=[fc], partial=True)

    events = await _collect_events(translator, adk_event)
    types = _event_types(events)

    assert "TOOL_CALL_START" in types
    start_event = [e for e in events if "TOOL_CALL_START" in str(e.type)][0]
    assert start_event.tool_call_name == "write_document"
    assert start_event.tool_call_id is not None


@pytest.mark.asyncio
async def test_streaming_fc_disabled_by_default():
    """Without flag, partial events with will_continue are skipped."""
    translator = EventTranslator()  # Default: streaming_function_call_arguments=False

    fc = _make_func_call(name="write_document", will_continue=True)
    adk_event = _make_adk_event(func_calls=[fc], partial=True)

    events = await _collect_events(translator, adk_event)
    types = _event_types(events)

    assert "TOOL_CALL_START" not in types


# ============================================================================
# Continuation chunk tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_continuation_emits_args():
    """Continuation chunks with partial_args emit TOOL_CALL_ARGS deltas."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # First chunk
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    event1 = _make_adk_event(func_calls=[fc1], partial=True)
    await _collect_events(translator, event1)

    # Continuation chunk
    pa = _make_partial_arg("$.document", "Hello world")
    fc2 = _make_func_call(partial_args=[pa], will_continue=True, fc_id="adk-2")
    event2 = _make_adk_event(func_calls=[fc2], partial=True)

    events = await _collect_events(translator, event2)
    types = _event_types(events)

    assert "TOOL_CALL_ARGS" in types
    args_event = [e for e in events if "TOOL_CALL_ARGS" in str(e.type)][0]
    assert "document" in args_event.delta
    assert "Hello world" in args_event.delta


@pytest.mark.asyncio
async def test_streaming_fc_multiple_continuations():
    """Multiple continuation chunks accumulate deltas correctly."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # First chunk
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    event1 = _make_adk_event(func_calls=[fc1], partial=True)
    start_events = await _collect_events(translator, event1)

    # Continuation 1
    pa1 = _make_partial_arg("$.document", "Once upon ")
    fc2 = _make_func_call(partial_args=[pa1], will_continue=True, fc_id="adk-2")
    event2 = _make_adk_event(func_calls=[fc2], partial=True)
    chunk1_events = await _collect_events(translator, event2)

    # Continuation 2
    pa2 = _make_partial_arg("$.document", "a time")
    fc3 = _make_func_call(partial_args=[pa2], will_continue=True, fc_id="adk-3")
    event3 = _make_adk_event(func_calls=[fc3], partial=True)
    chunk2_events = await _collect_events(translator, event3)

    # First continuation has key prefix, second has just the value
    assert len(chunk1_events) >= 1
    assert len(chunk2_events) >= 1
    assert "TOOL_CALL_ARGS" in _event_types(chunk1_events)
    assert "TOOL_CALL_ARGS" in _event_types(chunk2_events)

    # Second delta should just be the escaped text (no key prefix)
    args2 = [e for e in chunk2_events if "TOOL_CALL_ARGS" in str(e.type)][0]
    assert args2.delta == "a time"


# ============================================================================
# End marker tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_end_emits_end():
    """End marker emits closing JSON + TOOL_CALL_END."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # First chunk
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    event1 = _make_adk_event(func_calls=[fc1], partial=True)
    await _collect_events(translator, event1)

    # Continuation (opens JSON path)
    pa = _make_partial_arg("$.document", "content")
    fc2 = _make_func_call(partial_args=[pa], will_continue=True, fc_id="adk-2")
    event2 = _make_adk_event(func_calls=[fc2], partial=True)
    await _collect_events(translator, event2)

    # End marker
    fc_end = _make_func_call(fc_id="adk-3")  # no name, no partial_args, no will_continue
    event_end = _make_adk_event(func_calls=[fc_end], partial=True)
    events = await _collect_events(translator, event_end)
    types = _event_types(events)

    assert "TOOL_CALL_ARGS" in types  # Closing JSON '"}'
    assert "TOOL_CALL_END" in types

    # Closing JSON delta should be '"}'
    closing = [e for e in events if "TOOL_CALL_ARGS" in str(e.type)][0]
    assert closing.delta == '"}'


# ============================================================================
# Full streaming sequence tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_full_sequence():
    """Full streaming sequence produces START, ARGS..., ARGS (close), END."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # First chunk
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    all_events = await _collect_events(translator, _make_adk_event(func_calls=[fc1], partial=True))

    # Two continuations
    pa1 = _make_partial_arg("$.document", "Hello ")
    fc2 = _make_func_call(partial_args=[pa1], will_continue=True, fc_id="adk-2")
    all_events += await _collect_events(translator, _make_adk_event(func_calls=[fc2], partial=True))

    pa2 = _make_partial_arg("$.document", "World")
    fc3 = _make_func_call(partial_args=[pa2], will_continue=True, fc_id="adk-3")
    all_events += await _collect_events(translator, _make_adk_event(func_calls=[fc3], partial=True))

    # End marker
    fc_end = _make_func_call(fc_id="adk-4")
    all_events += await _collect_events(translator, _make_adk_event(func_calls=[fc_end], partial=True))

    types = _event_types(all_events)
    assert types[0] == "TOOL_CALL_START"
    assert types[-1] == "TOOL_CALL_END"
    assert types.count("TOOL_CALL_ARGS") == 3  # open, continuation, close


@pytest.mark.asyncio
async def test_streaming_fc_json_deltas_concatenate():
    """All TOOL_CALL_ARGS deltas concatenate to valid JSON."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # First chunk
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    all_events = await _collect_events(translator, _make_adk_event(func_calls=[fc1], partial=True))

    # Continuations
    pa1 = _make_partial_arg("$.document", "Hello ")
    fc2 = _make_func_call(partial_args=[pa1], will_continue=True, fc_id="adk-2")
    all_events += await _collect_events(translator, _make_adk_event(func_calls=[fc2], partial=True))

    pa2 = _make_partial_arg("$.document", "World")
    fc3 = _make_func_call(partial_args=[pa2], will_continue=True, fc_id="adk-3")
    all_events += await _collect_events(translator, _make_adk_event(func_calls=[fc3], partial=True))

    # End marker
    fc_end = _make_func_call(fc_id="adk-4")
    all_events += await _collect_events(translator, _make_adk_event(func_calls=[fc_end], partial=True))

    # Concatenate all TOOL_CALL_ARGS deltas
    args_deltas = [e.delta for e in all_events if "TOOL_CALL_ARGS" in str(e.type)]
    full_json = "".join(args_deltas)

    # Should be valid JSON
    parsed = json.loads(full_json)
    assert parsed == {"document": "Hello World"}


# ============================================================================
# Duplicate suppression tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_suppresses_final_aggregated():
    """Final aggregated (non-partial) event is suppressed after streaming."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # Stream: first -> end (minimal)
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    await _collect_events(translator, _make_adk_event(func_calls=[fc1], partial=True))

    fc_end = _make_func_call(fc_id="adk-2")
    await _collect_events(translator, _make_adk_event(func_calls=[fc_end], partial=True))

    # Final aggregated (non-partial) event
    fc_final = _make_func_call(
        name="write_document", args={"document": "full content"}, fc_id="adk-final"
    )
    final_event = _make_adk_event(func_calls=[fc_final], partial=False)
    events = await _collect_events(translator, final_event)

    types = _event_types(events)
    # Should NOT emit duplicate TOOL_CALL events
    assert "TOOL_CALL_START" not in types
    assert "TOOL_CALL_END" not in types


@pytest.mark.asyncio
async def test_streaming_fc_confirmed_id_remapped():
    """Confirmed FC id is remapped to streaming id for TOOL_CALL_RESULT."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # Stream: first -> end
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    start_events = await _collect_events(translator, _make_adk_event(func_calls=[fc1], partial=True))
    streaming_id = start_events[0].tool_call_id

    fc_end = _make_func_call(fc_id="adk-2")
    await _collect_events(translator, _make_adk_event(func_calls=[fc_end], partial=True))

    # Final aggregated triggers ID mapping
    fc_final = _make_func_call(
        name="write_document", args={"document": "content"}, fc_id="adk-final"
    )
    await _collect_events(translator, _make_adk_event(func_calls=[fc_final], partial=False))

    # Check ID mapping exists
    assert "adk-final" in translator._confirmed_to_streaming_id
    assert translator._confirmed_to_streaming_id["adk-final"] == streaming_id


# ============================================================================
# Stable ID tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_uses_stable_id():
    """All events in a streaming sequence use the same tool_call_id."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # First chunk
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    events1 = await _collect_events(translator, _make_adk_event(func_calls=[fc1], partial=True))
    start_id = events1[0].tool_call_id

    # Continuation
    pa = _make_partial_arg("$.document", "hello")
    fc2 = _make_func_call(partial_args=[pa], will_continue=True, fc_id="adk-2")
    events2 = await _collect_events(translator, _make_adk_event(func_calls=[fc2], partial=True))

    # End
    fc_end = _make_func_call(fc_id="adk-3")
    events3 = await _collect_events(translator, _make_adk_event(func_calls=[fc_end], partial=True))

    # All events should use the same stable ID
    all_ids = set()
    for e in events1 + events2 + events3:
        if hasattr(e, 'tool_call_id'):
            all_ids.add(e.tool_call_id)

    assert len(all_ids) == 1
    assert start_id in all_ids


# ============================================================================
# PredictState integration tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_with_predict_state():
    """PredictState CustomEvent is emitted before TOOL_CALL_START during streaming."""
    translator = EventTranslator(
        streaming_function_call_arguments=True,
        predict_state=[
            PredictStateMapping(
                state_key="document",
                tool="write_document",
                tool_argument="document",
            )
        ],
    )

    fc = _make_func_call(name="write_document", will_continue=True)
    adk_event = _make_adk_event(func_calls=[fc], partial=True)
    events = await _collect_events(translator, adk_event)

    types = _event_types(events)
    assert "CUSTOM" in types
    assert "TOOL_CALL_START" in types
    # PredictState should come before TOOL_CALL_START
    custom_idx = types.index("CUSTOM")
    start_idx = types.index("TOOL_CALL_START")
    assert custom_idx < start_idx

    custom_event = events[custom_idx]
    assert custom_event.name == "PredictState"


# ============================================================================
# Reset tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_resets_on_reset():
    """reset() clears all streaming FC state."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # Start streaming
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    await _collect_events(translator, _make_adk_event(func_calls=[fc1], partial=True))
    assert translator._active_streaming_fc_id is not None

    # Reset
    translator.reset()

    # State should be clean
    assert translator._active_streaming_fc_id is None
    assert translator._active_streaming_fc_name is None
    assert len(translator._streaming_fc_open_paths) == 0
    assert len(translator._streaming_fc_started_paths) == 0
    assert len(translator._completed_streaming_fc_names) == 0
    assert translator._last_completed_streaming_fc_name is None


# ============================================================================
# Version gate tests
# ============================================================================


def test_adk_version_gate():
    """_adk_supports_streaming_fc_args() returns True for current ADK (>=1.24.0)."""
    assert ADKAgent._adk_supports_streaming_fc_args() is True


# ============================================================================
# Edge case tests
# ============================================================================


@pytest.mark.asyncio
async def test_streaming_fc_stray_chunk_ignored():
    """Nameless chunks without active streaming are ignored."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # Send a continuation chunk without a preceding first chunk
    pa = _make_partial_arg("$.document", "orphan")
    fc = _make_func_call(partial_args=[pa], will_continue=True, fc_id="adk-stray")
    adk_event = _make_adk_event(func_calls=[fc], partial=True)

    events = await _collect_events(translator, adk_event)
    types = _event_types(events)

    assert "TOOL_CALL_START" not in types
    assert "TOOL_CALL_ARGS" not in types


@pytest.mark.asyncio
async def test_streaming_fc_special_chars_escaped():
    """Special characters in partial_args are properly JSON-escaped in deltas."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    # First chunk
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    await _collect_events(translator, _make_adk_event(func_calls=[fc1], partial=True))

    # Continuation with special chars
    pa = _make_partial_arg("$.document", 'He said "hello"\nNew line')
    fc2 = _make_func_call(partial_args=[pa], will_continue=True, fc_id="adk-2")
    events = await _collect_events(translator, _make_adk_event(func_calls=[fc2], partial=True))

    # End
    fc_end = _make_func_call(fc_id="adk-3")
    end_events = await _collect_events(translator, _make_adk_event(func_calls=[fc_end], partial=True))

    # Concatenate all args deltas and verify valid JSON
    all_events = events + end_events
    args_deltas = [e.delta for e in all_events if "TOOL_CALL_ARGS" in str(e.type)]
    full_json = "".join(args_deltas)
    parsed = json.loads(full_json)
    assert parsed == {"document": 'He said "hello"\nNew line'}


@pytest.mark.asyncio
async def test_streaming_fc_lro_skipped():
    """LRO function calls in partial events are skipped by streaming detection."""
    translator = EventTranslator(streaming_function_call_arguments=True)

    fc = _make_func_call(name="write_document", will_continue=True, fc_id="lro-1")
    adk_event = _make_adk_event(func_calls=[fc], partial=True, lro_ids=["lro-1"])

    events = await _collect_events(translator, adk_event)
    types = _event_types(events)

    assert "TOOL_CALL_START" not in types


@pytest.mark.asyncio
async def test_streaming_fc_deferred_end_for_stream_tool_call():
    """stream_tool_call=True defers TOOL_CALL_END."""
    translator = EventTranslator(
        streaming_function_call_arguments=True,
        predict_state=[
            PredictStateMapping(
                state_key="document",
                tool="write_document",
                tool_argument="document",
                stream_tool_call=True,
            )
        ],
    )

    # First chunk
    fc1 = _make_func_call(name="write_document", will_continue=True, fc_id="adk-1")
    await _collect_events(translator, _make_adk_event(func_calls=[fc1], partial=True))

    # End marker
    fc_end = _make_func_call(fc_id="adk-2")
    events = await _collect_events(translator, _make_adk_event(func_calls=[fc_end], partial=True))
    types = _event_types(events)

    # TOOL_CALL_END should NOT be emitted (deferred)
    assert "TOOL_CALL_END" not in types
