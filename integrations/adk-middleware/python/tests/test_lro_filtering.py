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


async def test_translate_skips_function_calls_from_partial_events_without_streaming_args():
    """Ensure function calls from partial events without accumulated args are skipped.

    With PROGRESSIVE_SSE_STREAMING (available in google-adk >= 1.20.0, enabled by
    default in >= 1.22.0), ADK's StreamingResponseAggregator consumes partial_args
    and exposes accumulated args. Early partial events may have no accumulated args
    yet (args=None). These should NOT be translated to TOOL_CALL events.

    Only partial events WITH accumulated args should emit streaming tool call events.

    See: https://github.com/ag-ui-protocol/ag-ui/issues/968
    """
    translator = EventTranslator()

    # Prepare mock ADK event with partial=True (streaming preview)
    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True  # This is a streaming preview
    adk_event.content = MagicMock()
    adk_event.content.parts = []  # no text

    # Function call in a partial event WITHOUT accumulated args should be skipped
    func_call = MagicMock()
    func_call.id = "preview-tool-call-1"
    func_call.name = "some_tool"
    func_call.args = None  # No accumulated args yet - should be skipped
    func_call.will_continue = True

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    # No tool call events should be emitted for partial events without accumulated args
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert event_types.count("TOOL_CALL_START") == 0, \
        f"Expected no TOOL_CALL_START from partial event without accumulated args, got {event_types}"
    assert event_types.count("TOOL_CALL_ARGS") == 0
    assert event_types.count("TOOL_CALL_END") == 0


async def test_translate_emits_streaming_function_calls_from_partial_events():
    """Ensure function calls from partial events WITH accumulated args emit streaming events.

    ADK's StreamingResponseAggregator exposes accumulated args on each partial event.
    We compute deltas between consecutive partials to emit incremental TOOL_CALL_ARGS
    for real-time UI updates.
    """
    translator = EventTranslator()

    # First partial event - starts the streaming function call with initial args
    adk_event1 = MagicMock()
    adk_event1.author = "assistant"
    adk_event1.partial = True
    adk_event1.content = MagicMock()
    adk_event1.content.parts = []

    func_call1 = MagicMock()
    func_call1.id = "streaming-tool-call-1"
    func_call1.name = "write_document_local"
    func_call1.args = {"document": "Hello "}  # Accumulated args so far
    func_call1.partial_args = None  # Raw partial_args consumed by aggregator
    func_call1.will_continue = True  # More to come

    adk_event1.get_function_calls = lambda: [func_call1]
    adk_event1.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event1, "thread", "run"):
        events.append(e)

    # Should emit TOOL_CALL_START and first TOOL_CALL_ARGS
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" in event_types, f"Expected TOOL_CALL_START, got {event_types}"
    assert "TOOL_CALL_ARGS" in event_types, f"Expected TOOL_CALL_ARGS, got {event_types}"
    # No TOOL_CALL_END yet since will_continue=True
    assert "TOOL_CALL_END" not in event_types, f"Unexpected TOOL_CALL_END, got {event_types}"

    # Second partial event - continues streaming with more accumulated args
    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = True
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []

    func_call2 = MagicMock()
    func_call2.id = "streaming-tool-call-1"  # Same ID
    func_call2.name = "write_document_local"
    func_call2.args = {"document": "Hello World!"}  # More accumulated
    func_call2.partial_args = None
    func_call2.will_continue = False  # Streaming complete

    adk_event2.get_function_calls = lambda: [func_call2]
    adk_event2.long_running_tool_ids = []

    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    # Should emit more TOOL_CALL_ARGS (the delta) and TOOL_CALL_END
    event_types2 = [str(ev.type).split('.')[-1] for ev in events2]
    assert "TOOL_CALL_ARGS" in event_types2, f"Expected TOOL_CALL_ARGS, got {event_types2}"
    assert "TOOL_CALL_END" in event_types2, f"Expected TOOL_CALL_END, got {event_types2}"


async def test_translate_skips_complete_call_after_streaming():
    """Ensure that once a function call is streamed, the final complete call is skipped.

    When we stream a function call via partial events, the final non-partial event
    containing the same function call should be skipped to avoid duplicates.
    """
    translator = EventTranslator()

    # First: Stream the function call via partial event with accumulated args
    adk_event1 = MagicMock()
    adk_event1.author = "assistant"
    adk_event1.partial = True
    adk_event1.content = MagicMock()
    adk_event1.content.parts = []

    func_call1 = MagicMock()
    func_call1.id = "streamed-tool-call-1"
    func_call1.name = "write_document_local"
    func_call1.args = {"document": "Test"}  # Accumulated args
    func_call1.partial_args = None
    func_call1.will_continue = False  # Complete

    adk_event1.get_function_calls = lambda: [func_call1]
    adk_event1.long_running_tool_ids = []

    # Process partial event
    events1 = []
    async for e in translator.translate(adk_event1, "thread", "run"):
        events1.append(e)

    # Should have emitted START, ARGS, END
    event_types1 = [str(ev.type).split('.')[-1] for ev in events1]
    assert "TOOL_CALL_START" in event_types1
    assert "TOOL_CALL_END" in event_types1

    # Now: Final complete event arrives (partial=False)
    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = False  # Complete event
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []

    func_call2 = MagicMock()
    func_call2.id = "streamed-tool-call-1"  # Same ID as streamed call
    func_call2.name = "write_document_local"
    func_call2.args = {"document": "Test"}
    func_call2.partial_args = None

    adk_event2.get_function_calls = lambda: [func_call2]
    adk_event2.long_running_tool_ids = []

    # Process final complete event
    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    # Should NOT emit duplicate TOOL_CALL events for the already-streamed call
    event_types2 = [str(ev.type).split('.')[-1] for ev in events2]
    assert "TOOL_CALL_START" not in event_types2, \
        f"Should skip already-streamed function call, got {event_types2}"


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


async def test_mode_a_streaming_fc_with_flag_enabled():
    """Mode A: streaming_function_call_arguments=True enables first-chunk dispatch.

    When streaming_function_call_arguments=True, a partial event with
    name + will_continue=True + args=None should enter the streaming FC path.
    """
    translator = EventTranslator(streaming_function_call_arguments=True)

    # First chunk: name + will_continue, no args
    adk_event1 = MagicMock()
    adk_event1.author = "assistant"
    adk_event1.partial = True
    adk_event1.content = MagicMock()
    adk_event1.content.parts = []

    func_call1 = MagicMock()
    func_call1.id = "mode-a-tool-1"
    func_call1.name = "write_document_local"
    func_call1.args = None  # No accumulated args yet
    func_call1.partial_args = None  # No partial_args on first chunk
    func_call1.will_continue = True

    adk_event1.get_function_calls = lambda: [func_call1]
    adk_event1.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event1, "thread", "run"):
        events.append(e)

    # With the flag enabled, first chunk should emit TOOL_CALL_START
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" in event_types, \
        f"Expected TOOL_CALL_START for Mode A first chunk, got {event_types}"

    # Second chunk: partial_args with content
    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = True
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []

    partial_arg = MagicMock()
    partial_arg.string_value = "Hello world"
    partial_arg.json_path = "$.document"

    func_call2 = MagicMock()
    func_call2.id = None  # ADK assigns fresh adk-<uuid> but we use None in test
    func_call2.name = None  # No name on continuation chunks
    func_call2.args = None
    func_call2.partial_args = [partial_arg]
    func_call2.will_continue = True

    adk_event2.get_function_calls = lambda: [func_call2]
    adk_event2.long_running_tool_ids = []

    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    event_types2 = [str(ev.type).split('.')[-1] for ev in events2]
    assert "TOOL_CALL_ARGS" in event_types2, \
        f"Expected TOOL_CALL_ARGS for Mode A middle chunk, got {event_types2}"

    # End chunk: no name, will_continue=None/False
    adk_event3 = MagicMock()
    adk_event3.author = "assistant"
    adk_event3.partial = True
    adk_event3.content = MagicMock()
    adk_event3.content.parts = []

    func_call3 = MagicMock()
    func_call3.id = None
    func_call3.name = None
    func_call3.args = None
    func_call3.partial_args = None
    func_call3.will_continue = None  # End marker

    adk_event3.get_function_calls = lambda: [func_call3]
    adk_event3.long_running_tool_ids = []

    events3 = []
    async for e in translator.translate(adk_event3, "thread", "run"):
        events3.append(e)

    event_types3 = [str(ev.type).split('.')[-1] for ev in events3]
    assert "TOOL_CALL_END" in event_types3, \
        f"Expected TOOL_CALL_END for Mode A end chunk, got {event_types3}"


async def test_mode_a_first_chunk_skipped_without_flag():
    """Mode A first chunk is skipped when streaming_function_call_arguments=False (default).

    This is the same scenario as test_translate_skips_function_calls_from_partial_events_without_streaming_args
    but explicitly tests that the flag=False (default) prevents Mode A dispatch.
    """
    translator = EventTranslator()  # Default: streaming_function_call_arguments=False

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = "mode-a-skipped-1"
    func_call.name = "some_tool"
    func_call.args = None
    func_call.partial_args = None
    func_call.will_continue = True

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" not in event_types, \
        f"Mode A first chunk should be skipped without flag, got {event_types}"


async def test_same_tool_called_twice_not_suppressed():
    """Calling the same tool twice should not suppress the second invocation.

    Regression test for name-based dedup fragility.
    """
    translator = EventTranslator()

    # First invocation: stream and complete
    adk_event1 = MagicMock()
    adk_event1.author = "assistant"
    adk_event1.partial = True
    adk_event1.content = MagicMock()
    adk_event1.content.parts = []

    func_call1 = MagicMock()
    func_call1.id = "tool-call-1"
    func_call1.name = "write_document_local"
    func_call1.args = {"document": "First"}
    func_call1.partial_args = None
    func_call1.will_continue = False

    adk_event1.get_function_calls = lambda: [func_call1]
    adk_event1.long_running_tool_ids = []

    async for _ in translator.translate(adk_event1, "thread", "run"):
        pass

    # Non-partial event for first call (should be filtered)
    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = False
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []

    func_call2 = MagicMock()
    func_call2.id = "tool-call-1"
    func_call2.name = "write_document_local"
    func_call2.args = {"document": "First"}

    adk_event2.get_function_calls = lambda: [func_call2]
    adk_event2.long_running_tool_ids = []

    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    # First non-partial should be filtered
    event_types2 = [str(ev.type).split('.')[-1] for ev in events2]
    assert "TOOL_CALL_START" not in event_types2

    # Second invocation of same tool (should NOT be suppressed)
    adk_event3 = MagicMock()
    adk_event3.author = "assistant"
    adk_event3.partial = True
    adk_event3.content = MagicMock()
    adk_event3.content.parts = []

    func_call3 = MagicMock()
    func_call3.id = "tool-call-2"
    func_call3.name = "write_document_local"  # Same tool name!
    func_call3.args = {"document": "Second"}
    func_call3.partial_args = None
    func_call3.will_continue = False

    adk_event3.get_function_calls = lambda: [func_call3]
    adk_event3.long_running_tool_ids = []

    events3 = []
    async for e in translator.translate(adk_event3, "thread", "run"):
        events3.append(e)

    event_types3 = [str(ev.type).split('.')[-1] for ev in events3]
    assert "TOOL_CALL_START" in event_types3, \
        f"Second invocation of same tool should NOT be suppressed, got {event_types3}"
    assert "TOOL_CALL_END" in event_types3


if __name__ == "__main__":
    asyncio.run(test_translate_skips_lro_function_calls())
    asyncio.run(test_translate_lro_function_calls_only_emits_lro())
    asyncio.run(test_translate_skips_function_calls_from_partial_events_without_streaming_args())
    asyncio.run(test_translate_emits_function_calls_from_confirmed_events())
    asyncio.run(test_translate_handles_missing_partial_attribute())
    asyncio.run(test_mode_a_streaming_fc_with_flag_enabled())
    asyncio.run(test_mode_a_first_chunk_skipped_without_flag())
    asyncio.run(test_same_tool_called_twice_not_suppressed())
    print("\n✅ LRO and partial filtering tests ran to completion")

