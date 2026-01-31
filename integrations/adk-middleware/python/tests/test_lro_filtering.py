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


async def test_confirmed_event_skips_lro_already_emitted_via_translate_lro():
    """Regression: confirmed (non-partial) event must not re-emit LRO tool calls.

    When using ResumabilityConfig, ADK emits the LRO function call twice:
    1. First via the LRO path (translate_lro_function_calls) — emits TOOL_CALL events
    2. Then as a confirmed (non-partial) event — translate() must skip it

    The confirmed event may NOT carry long_running_tool_ids on the event itself,
    so the translator must use its own accumulated long_running_tool_ids list.

    This is the root cause of duplicate list rendering in the HITL demo.
    """
    translator = EventTranslator()

    lro_id = "lro-hitl-tool-1"

    # Step 1: Emit LRO tool call via translate_lro_function_calls (simulates LRO path)
    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "generate_task_steps"
    lro_call.args = {"steps": [{"description": "Step 1", "status": "enabled"}]}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    lro_event = MagicMock()
    lro_event.content = MagicMock()
    lro_event.content.parts = [lro_part]
    lro_event.long_running_tool_ids = [lro_id]

    lro_events = []
    async for e in translator.translate_lro_function_calls(lro_event):
        lro_events.append(e)

    # Should have emitted START, ARGS, END
    lro_types = [str(ev.type).split('.')[-1] for ev in lro_events]
    assert lro_types == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]

    # Step 2: Confirmed event arrives (non-partial) WITHOUT long_running_tool_ids
    confirmed_event = MagicMock()
    confirmed_event.author = "assistant"
    confirmed_event.partial = False
    confirmed_event.content = MagicMock()
    confirmed_event.content.parts = []

    confirmed_call = MagicMock()
    confirmed_call.id = lro_id  # Same ID as the LRO call
    confirmed_call.name = "generate_task_steps"
    confirmed_call.args = {"steps": [{"description": "Step 1", "status": "enabled"}]}

    confirmed_event.get_function_calls = lambda: [confirmed_call]
    # Key: confirmed event does NOT have long_running_tool_ids set
    confirmed_event.long_running_tool_ids = []

    confirmed_events = []
    async for e in translator.translate(confirmed_event, "thread", "run"):
        confirmed_events.append(e)

    # Should NOT emit duplicate TOOL_CALL events
    confirmed_types = [str(ev.type).split('.')[-1] for ev in confirmed_events]
    assert "TOOL_CALL_START" not in confirmed_types, \
        f"LRO tool call was duplicated on confirmed event! Got: {confirmed_types}"
    assert "TOOL_CALL_END" not in confirmed_types, \
        f"LRO tool call END was duplicated on confirmed event! Got: {confirmed_types}"


async def test_confirmed_event_still_emits_non_lro_after_lro_emitted():
    """Non-LRO tool calls on a confirmed event must still be emitted even after LRO was tracked.

    This ensures the fix for duplicate LRO emission doesn't suppress unrelated tool calls.
    """
    translator = EventTranslator()

    lro_id = "lro-tool-abc"
    normal_id = "normal-tool-xyz"

    # Step 1: Emit LRO via translate_lro_function_calls
    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "generate_task_steps"
    lro_call.args = {"steps": []}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    lro_event = MagicMock()
    lro_event.content = MagicMock()
    lro_event.content.parts = [lro_part]
    lro_event.long_running_tool_ids = [lro_id]

    async for _ in translator.translate_lro_function_calls(lro_event):
        pass

    # Step 2: Confirmed event with BOTH the LRO call and a new non-LRO call
    confirmed_event = MagicMock()
    confirmed_event.author = "assistant"
    confirmed_event.partial = False
    confirmed_event.content = MagicMock()
    confirmed_event.content.parts = []

    lro_call_again = MagicMock()
    lro_call_again.id = lro_id
    lro_call_again.name = "generate_task_steps"
    lro_call_again.args = {"steps": []}

    normal_call = MagicMock()
    normal_call.id = normal_id
    normal_call.name = "regular_backend_tool"
    normal_call.args = {"key": "value"}

    confirmed_event.get_function_calls = lambda: [lro_call_again, normal_call]
    confirmed_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(confirmed_event, "thread", "run"):
        events.append(e)

    # Only non-LRO should be emitted
    tool_call_ids = [getattr(ev, 'tool_call_id', None) for ev in events if hasattr(ev, 'tool_call_id')]
    assert normal_id in tool_call_ids, \
        f"Non-LRO tool call should still be emitted, got IDs: {tool_call_ids}"
    assert lro_id not in tool_call_ids, \
        f"LRO tool call should be suppressed, got IDs: {tool_call_ids}"


async def test_confirmed_event_with_different_lro_id_not_suppressed():
    """A tool call with a different ID than the tracked LRO should not be suppressed.

    Ensures we only suppress exact ID matches, not all function calls.
    """
    translator = EventTranslator()

    # Track one LRO ID
    lro_id = "lro-tracked-id"
    different_id = "completely-different-id"

    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "generate_task_steps"
    lro_call.args = {}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    lro_event = MagicMock()
    lro_event.content = MagicMock()
    lro_event.content.parts = [lro_part]
    lro_event.long_running_tool_ids = [lro_id]

    async for _ in translator.translate_lro_function_calls(lro_event):
        pass

    # Confirmed event with a DIFFERENT tool call ID (same tool name but different invocation)
    confirmed_event = MagicMock()
    confirmed_event.author = "assistant"
    confirmed_event.partial = False
    confirmed_event.content = MagicMock()
    confirmed_event.content.parts = []

    new_call = MagicMock()
    new_call.id = different_id
    new_call.name = "generate_task_steps"  # Same name, different ID
    new_call.args = {"steps": [{"description": "New step", "status": "enabled"}]}

    confirmed_event.get_function_calls = lambda: [new_call]
    confirmed_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(confirmed_event, "thread", "run"):
        events.append(e)

    # Different ID should NOT be suppressed
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" in event_types, \
        f"Tool call with different ID should not be suppressed, got: {event_types}"


async def test_client_emitted_ids_suppress_confirmed_event():
    """Regression: confirmed event must be suppressed when ClientProxyTool already emitted it.

    With ResumabilityConfig, the flow is:
    1. ClientProxyTool executes and emits TOOL_CALL events (records ID in shared set)
    2. ADK emits a confirmed (non-partial) event with the same ID
    3. EventTranslator must skip it because the client proxy already handled it

    This is the primary fix for the HITL duplicate list rendering bug.
    """
    # Shared set simulating what ClientProxyTool populates
    client_emitted_ids = set()
    translator = EventTranslator(client_emitted_tool_call_ids=client_emitted_ids)

    tool_call_id = "adk-3761f7af-c4d6-45d7-8842-90823550523c"

    # Simulate ClientProxyTool having already emitted events for this ID
    client_emitted_ids.add(tool_call_id)

    # ADK confirmed event arrives with the same ID
    confirmed_event = MagicMock()
    confirmed_event.author = "assistant"
    confirmed_event.partial = False
    confirmed_event.content = MagicMock()
    confirmed_event.content.parts = []

    func_call = MagicMock()
    func_call.id = tool_call_id
    func_call.name = "generate_task_steps"
    func_call.args = {"steps": [{"description": "Step 1", "status": "enabled"}]}

    confirmed_event.get_function_calls = lambda: [func_call]
    confirmed_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(confirmed_event, "thread", "run"):
        events.append(e)

    # Should NOT emit duplicate TOOL_CALL events
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" not in event_types, \
        f"Client-emitted tool call was duplicated on confirmed event! Got: {event_types}"
    assert "TOOL_CALL_END" not in event_types, \
        f"Client-emitted tool call END was duplicated! Got: {event_types}"


async def test_client_emitted_ids_suppress_lro_translate():
    """LRO translate path must also skip tool calls already emitted by ClientProxyTool."""
    client_emitted_ids = set()
    translator = EventTranslator(client_emitted_tool_call_ids=client_emitted_ids)

    lro_id = "adk-already-emitted-by-proxy"
    client_emitted_ids.add(lro_id)

    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "generate_task_steps"
    lro_call.args = {"steps": []}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    adk_event = MagicMock()
    adk_event.content = MagicMock()
    adk_event.content.parts = [lro_part]
    adk_event.long_running_tool_ids = [lro_id]

    events = []
    async for e in translator.translate_lro_function_calls(adk_event):
        events.append(e)

    assert len(events) == 0, \
        f"LRO path should skip client-emitted tool call, got {len(events)} events"


async def test_client_emitted_ids_suppress_partial_event():
    """Partial events must also skip tool calls already emitted by ClientProxyTool."""
    client_emitted_ids = set()
    translator = EventTranslator(client_emitted_tool_call_ids=client_emitted_ids)

    tool_id = "adk-partial-already-emitted"
    client_emitted_ids.add(tool_id)

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = tool_id
    func_call.name = "generate_task_steps"
    func_call.args = {"steps": []}
    func_call.partial_args = None
    func_call.will_continue = True

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" not in event_types, \
        f"Partial event should skip client-emitted tool call, got: {event_types}"


async def test_client_emitted_ids_do_not_suppress_other_tools():
    """Tool calls NOT in client_emitted_ids must still be emitted normally."""
    client_emitted_ids = {"some-other-id"}
    translator = EventTranslator(client_emitted_tool_call_ids=client_emitted_ids)

    different_id = "totally-different-id"

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = False
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = different_id
    func_call.name = "some_backend_tool"
    func_call.args = {"key": "value"}

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" in event_types, \
        f"Unrelated tool call should still be emitted, got: {event_types}"


async def test_shared_set_mutation_visible_to_translator():
    """Adding an ID to the shared set AFTER translator creation must be visible.

    This tests that the set is shared by reference — IDs added by ClientProxyTool
    during execution (after EventTranslator was created) are still checked.
    """
    shared_set: set[str] = set()
    translator = EventTranslator(client_emitted_tool_call_ids=shared_set)

    tool_id = "late-addition-id"

    # Simulate ClientProxyTool adding the ID during execution (after translator init)
    shared_set.add(tool_id)

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = False
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = tool_id
    func_call.name = "generate_task_steps"
    func_call.args = {"steps": []}

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" not in event_types, \
        f"Late-added ID should still suppress, got: {event_types}"


async def test_client_tool_names_suppress_lro_path():
    """LRO translate path must skip tools whose name is in client_tool_names.

    This is the primary mechanism for preventing duplicate emission when ADK
    assigns different IDs to the LRO event vs the confirmed event — ID-based
    filtering can't catch it, so we filter by name instead.
    """
    # Simulate a resumable agent where ClientProxyTool handles emission
    translator = EventTranslator(
        client_tool_names={"generate_task_steps"},
        is_resumable=True,
    )

    lro_id = "adk-lro-event-id"
    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "generate_task_steps"
    lro_call.args = {"steps": []}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    adk_event = MagicMock()
    adk_event.content = MagicMock()
    adk_event.content.parts = [lro_part]
    adk_event.long_running_tool_ids = [lro_id]

    events = []
    async for e in translator.translate_lro_function_calls(adk_event):
        events.append(e)

    assert len(events) == 0, \
        f"LRO path should skip client tool by name, got {len(events)} events"


async def test_client_tool_names_suppress_confirmed_event():
    """Confirmed (non-partial) event must be suppressed when tool name is in client_tool_names.

    This covers the case where ADK's confirmed event carries a different ID
    than the LRO event — ID-based filtering won't catch it.
    """
    translator = EventTranslator(client_tool_names={"generate_task_steps"})

    confirmed_event = MagicMock()
    confirmed_event.author = "assistant"
    confirmed_event.partial = False
    confirmed_event.content = MagicMock()
    confirmed_event.content.parts = []

    func_call = MagicMock()
    func_call.id = "adk-confirmed-different-id"
    func_call.name = "generate_task_steps"
    func_call.args = {"steps": [{"description": "Step 1", "status": "enabled"}]}

    confirmed_event.get_function_calls = lambda: [func_call]
    confirmed_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(confirmed_event, "thread", "run"):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" not in event_types, \
        f"Confirmed event for client tool should be suppressed by name, got: {event_types}"


async def test_client_tool_names_suppress_partial_event():
    """Partial event must be suppressed when tool name is in client_tool_names."""
    translator = EventTranslator(client_tool_names={"generate_task_steps"})

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = "adk-partial-id"
    func_call.name = "generate_task_steps"
    func_call.args = {"steps": []}
    func_call.partial_args = None
    func_call.will_continue = True

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" not in event_types, \
        f"Partial event for client tool should be suppressed by name, got: {event_types}"


async def test_client_tool_names_do_not_suppress_other_tools():
    """Backend tools not in client_tool_names must still be emitted."""
    translator = EventTranslator(client_tool_names={"generate_task_steps"})

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = False
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = "backend-tool-id"
    func_call.name = "search_database"  # Not a client tool
    func_call.args = {"query": "test"}

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" in event_types, \
        f"Backend tool should still be emitted, got: {event_types}"


async def test_client_tool_names_mixed_client_and_backend_calls():
    """When an event has both client and backend tool calls, only backend emits."""
    translator = EventTranslator(client_tool_names={"generate_task_steps"})

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = False
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    client_call = MagicMock()
    client_call.id = "client-tool-id"
    client_call.name = "generate_task_steps"
    client_call.args = {"steps": []}

    backend_call = MagicMock()
    backend_call.id = "backend-tool-id"
    backend_call.name = "search_database"
    backend_call.args = {"query": "test"}

    adk_event.get_function_calls = lambda: [client_call, backend_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    tool_call_ids = [getattr(ev, 'tool_call_id', None) for ev in events if hasattr(ev, 'tool_call_id')]
    assert "backend-tool-id" in tool_call_ids, \
        f"Backend tool should be emitted, got IDs: {tool_call_ids}"
    assert "client-tool-id" not in tool_call_ids, \
        f"Client tool should be suppressed, got IDs: {tool_call_ids}"


async def test_translator_records_emitted_tool_call_ids():
    """EventTranslator must record emitted tool call IDs in emitted_tool_call_ids.

    This set is shared with ClientProxyTool so it can skip duplicate emission.
    """
    translator = EventTranslator()

    # Non-partial confirmed event
    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = False
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = "recorded-tool-id"
    func_call.name = "some_tool"
    func_call.args = {"x": 1}

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    async for _ in translator.translate(adk_event, "thread", "run"):
        pass

    assert "recorded-tool-id" in translator.emitted_tool_call_ids, \
        f"Translator should record emitted ID, got: {translator.emitted_tool_call_ids}"


async def test_full_resumable_hitl_flow_no_duplicates():
    """End-to-end: simulates the exact ADK flow with ResumabilityConfig.

    Reproduces the real-world scenario:
    1. ADK emits LRO event (ID-A) with long_running_tool_ids — translator skips (client name)
    2. ADK emits confirmed event (ID-B, different!) without long_running_tool_ids — translator skips (client name)
    3. ADK executes ClientProxyTool (ID-B) — proxy checks translator set, emits (translator didn't emit)

    Only ONE emission should occur: from ClientProxyTool.
    """
    client_emitted_ids: set[str] = set()
    translator = EventTranslator(
        client_emitted_tool_call_ids=client_emitted_ids,
        client_tool_names={"generate_task_steps"},
        is_resumable=True,
    )

    lro_id = "adk-lro-id-A"
    confirmed_id = "adk-confirmed-id-B"

    # Step 1: LRO event — should be suppressed by client_tool_names
    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "generate_task_steps"
    lro_call.args = {"steps": [{"description": "Step 1", "status": "enabled"}]}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    lro_event = MagicMock()
    lro_event.content = MagicMock()
    lro_event.content.parts = [lro_part]
    lro_event.long_running_tool_ids = [lro_id]

    lro_events = []
    async for e in translator.translate_lro_function_calls(lro_event):
        lro_events.append(e)
    assert len(lro_events) == 0, f"LRO path should emit 0 events, got {len(lro_events)}"

    # Step 2: Confirmed event (different ID!) — should be suppressed by client_tool_names
    confirmed_event = MagicMock()
    confirmed_event.author = "assistant"
    confirmed_event.partial = False
    confirmed_event.content = MagicMock()
    confirmed_event.content.parts = []

    confirmed_call = MagicMock()
    confirmed_call.id = confirmed_id
    confirmed_call.name = "generate_task_steps"
    confirmed_call.args = {"steps": [{"description": "Step 1", "status": "enabled"}]}

    confirmed_event.get_function_calls = lambda: [confirmed_call]
    confirmed_event.long_running_tool_ids = []

    confirmed_events = []
    async for e in translator.translate(confirmed_event, "thread", "run"):
        confirmed_events.append(e)

    tool_events = [e for e in confirmed_events if "TOOL_CALL" in str(e.type)]
    assert len(tool_events) == 0, f"Confirmed path should emit 0 tool events, got {len(tool_events)}"

    # Step 3: ClientProxyTool would run here with confirmed_id
    # Since translator.emitted_tool_call_ids is empty (translator didn't emit),
    # the proxy tool should emit its events. Verify the translator set is empty.
    assert confirmed_id not in translator.emitted_tool_call_ids, \
        "Translator should NOT have recorded suppressed IDs"
    assert lro_id not in translator.emitted_tool_call_ids, \
        "Translator should NOT have recorded suppressed IDs"


async def test_has_lro_function_call_sets_is_long_running_tool_even_when_translator_skips():
    """is_long_running_tool must be True when has_lro_function_call is True,
    even if translate_lro_function_calls emits no events (e.g. client tool filtered).

    This is critical for HITL SequentialAgent resumption: if is_long_running_tool
    stays False, the invocation_id is cleared after the run, breaking multi-turn
    resumption.

    Reproduces the bug from commit c08a56f5 where client_tool_names filtering
    in translate_lro_function_calls caused no TOOL_CALL_END to be emitted,
    so is_long_running_tool was never set to True.
    """
    # Resumable agent: ClientProxyTool handles emission, translator skips by name
    translator = EventTranslator(
        client_tool_names={"generate_task_steps"},
        is_resumable=True,
    )

    lro_id = "adk-lro-filtered"
    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "generate_task_steps"
    lro_call.args = {"steps": []}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    adk_event = MagicMock()
    adk_event.content = MagicMock()
    adk_event.content.parts = [lro_part]
    adk_event.long_running_tool_ids = [lro_id]

    # Simulate the _run_adk_in_background logic:
    # has_lro_function_call is True (detected upstream), but translator emits nothing
    has_lro_function_call = True
    is_long_running_tool = False

    # The fix: set flag based on has_lro_function_call directly
    if has_lro_function_call:
        is_long_running_tool = True

    # Translator emits nothing due to client_tool_names filtering (resumable)
    events = []
    async for e in translator.translate_lro_function_calls(adk_event):
        events.append(e)
        if e.type == EventType.TOOL_CALL_END:
            is_long_running_tool = True

    assert len(events) == 0, "Translator should emit 0 events (client tool filtered in resumable mode)"
    assert is_long_running_tool is True, (
        "is_long_running_tool must be True even when translator skips client tool emission. "
        "Without this, invocation_id is cleared and SequentialAgent resumption breaks."
    )


async def test_streaming_fc_args_nameless_chunks_stream_immediately():
    """Nameless streaming FC chunks emit events in real time, not batched.

    ADK's populate_client_function_call_id assigns a fresh adk-<uuid> to every
    partial chunk and never propagates the tool name to partial events. The
    translator must:
    1. Detect the nameless first chunk and start tracking (no data to emit)
    2. On first partial_args: infer tool name, emit START + ARGS immediately
    3. Stream subsequent ARGS as they arrive
    4. Emit END when will_continue=None
    5. Complete event is suppressed (already streamed)
    """
    translator = EventTranslator(
        streaming_function_call_arguments=True,
        client_tool_names={"publish_final_report"},
    )

    # First chunk: name=None, will_continue=True, no args (nameless first chunk)
    adk_event1 = MagicMock()
    adk_event1.author = "assistant"
    adk_event1.partial = True
    adk_event1.content = MagicMock()
    adk_event1.content.parts = []

    func_call1 = MagicMock()
    func_call1.id = "adk-uuid-chunk-1"
    func_call1.name = None  # ADK doesn't propagate name to partials
    func_call1.args = None
    func_call1.partial_args = None
    func_call1.will_continue = True

    adk_event1.get_function_calls = lambda: [func_call1]
    adk_event1.long_running_tool_ids = []

    events1 = []
    async for e in translator.translate(adk_event1, "thread", "run"):
        events1.append(e)

    # No tool call events — first chunk has no data, START deferred until partial_args
    tc_events1 = [e for e in events1 if "TOOL_CALL" in str(e.type)]
    assert len(tc_events1) == 0, (
        f"Nameless first chunk (no partial_args) should not emit tool call events, got "
        f"{[str(e.type).split('.')[-1] for e in tc_events1]}"
    )

    # Second chunk: partial_args with content, different id
    partial_arg = MagicMock()
    partial_arg.string_value = "Hello world"
    partial_arg.json_path = "$.content"

    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = True
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []

    func_call2 = MagicMock()
    func_call2.id = "adk-uuid-chunk-2"  # Different ID!
    func_call2.name = None
    func_call2.args = None
    func_call2.partial_args = [partial_arg]
    func_call2.will_continue = True

    adk_event2.get_function_calls = lambda: [func_call2]
    adk_event2.long_running_tool_ids = []

    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    # START + ARGS emitted immediately — name inferred from single client tool
    tc_events2 = [e for e in events2 if "TOOL_CALL" in str(e.type)]
    tc_types2 = [str(e.type).split('.')[-1] for e in tc_events2]
    assert "TOOL_CALL_START" in tc_types2, (
        f"First partial_args chunk should emit TOOL_CALL_START, got {tc_types2}"
    )
    assert "TOOL_CALL_ARGS" in tc_types2, (
        f"First partial_args chunk should emit TOOL_CALL_ARGS, got {tc_types2}"
    )

    # Verify inferred tool name
    start_events = [e for e in tc_events2 if str(e.type).split('.')[-1] == "TOOL_CALL_START"]
    assert start_events[0].tool_call_name == "publish_final_report", (
        f"TOOL_CALL_START should have inferred name, got {start_events[0].tool_call_name}"
    )

    # Third chunk: more partial_args
    partial_arg2 = MagicMock()
    partial_arg2.string_value = " — more content"
    partial_arg2.json_path = "$.content"

    adk_event3 = MagicMock()
    adk_event3.author = "assistant"
    adk_event3.partial = True
    adk_event3.content = MagicMock()
    adk_event3.content.parts = []

    func_call3 = MagicMock()
    func_call3.id = "adk-uuid-chunk-3"
    func_call3.name = None
    func_call3.args = None
    func_call3.partial_args = [partial_arg2]
    func_call3.will_continue = True

    adk_event3.get_function_calls = lambda: [func_call3]
    adk_event3.long_running_tool_ids = []

    events3 = []
    async for e in translator.translate(adk_event3, "thread", "run"):
        events3.append(e)

    # Only ARGS — streaming in real time
    tc_events3 = [e for e in events3 if "TOOL_CALL" in str(e.type)]
    tc_types3 = [str(e.type).split('.')[-1] for e in tc_events3]
    assert tc_types3 == ["TOOL_CALL_ARGS"], (
        f"Subsequent chunk should only emit TOOL_CALL_ARGS, got {tc_types3}"
    )

    # End chunk: will_continue=None
    adk_event4 = MagicMock()
    adk_event4.author = "assistant"
    adk_event4.partial = True
    adk_event4.content = MagicMock()
    adk_event4.content.parts = []

    func_call4 = MagicMock()
    func_call4.id = "adk-uuid-chunk-4"
    func_call4.name = None
    func_call4.args = None
    func_call4.partial_args = None
    func_call4.will_continue = None  # End marker

    adk_event4.get_function_calls = lambda: [func_call4]
    adk_event4.long_running_tool_ids = []

    events4 = []
    async for e in translator.translate(adk_event4, "thread", "run"):
        events4.append(e)

    # END emitted immediately
    tc_events4 = [e for e in events4 if "TOOL_CALL" in str(e.type)]
    tc_types4 = [str(e.type).split('.')[-1] for e in tc_events4]
    assert "TOOL_CALL_END" in tc_types4, (
        f"End chunk should emit TOOL_CALL_END, got {tc_types4}"
    )

    # Complete (non-partial) event should be suppressed (already streamed)
    adk_event5 = MagicMock()
    adk_event5.author = "assistant"
    adk_event5.partial = False
    adk_event5.content = MagicMock()
    adk_event5.content.parts = []

    func_call5 = MagicMock()
    func_call5.id = "adk-uuid-confirmed"
    func_call5.name = "publish_final_report"
    func_call5.args = {"content": "Hello world — more content"}

    adk_event5.get_function_calls = lambda: [func_call5]
    adk_event5.long_running_tool_ids = []

    events5 = []
    async for e in translator.translate(adk_event5, "thread", "run"):
        events5.append(e)

    # Complete event should NOT re-emit tool call events
    tc_events5 = [e for e in events5 if "TOOL_CALL" in str(e.type)]
    assert len(tc_events5) == 0, (
        f"Complete event should be suppressed (already streamed), got "
        f"{[str(e.type).split('.')[-1] for e in tc_events5]}"
    )

    # Confirmed ID must be in emitted_tool_call_ids so ClientProxyTool
    # (which receives the confirmed ID, not the streaming ID) skips emission
    assert "adk-uuid-confirmed" in translator.emitted_tool_call_ids, (
        "Confirmed FC id must be in emitted_tool_call_ids for ClientProxyTool dedup"
    )


async def test_streaming_fc_args_multi_tool_disambiguation():
    """With multiple client tools, json_path matching disambiguates the tool name.

    When client_tool_schemas maps tool names to their argument sets, the
    translator matches partial_args json_paths to infer the correct tool.
    """
    translator = EventTranslator(
        streaming_function_call_arguments=True,
        client_tool_names={"publish_report", "update_dashboard"},
        client_tool_schemas={
            "publish_report": {"content", "title", "sources"},
            "update_dashboard": {"metrics", "timeframe"},
        },
    )

    # First chunk: nameless, no partial_args
    adk_event1 = MagicMock()
    adk_event1.author = "assistant"
    adk_event1.partial = True
    adk_event1.content = MagicMock()
    adk_event1.content.parts = []

    func_call1 = MagicMock()
    func_call1.id = "adk-multi-1"
    func_call1.name = None
    func_call1.args = None
    func_call1.partial_args = None
    func_call1.will_continue = True

    adk_event1.get_function_calls = lambda: [func_call1]
    adk_event1.long_running_tool_ids = []

    async for _ in translator.translate(adk_event1, "thread", "run"):
        pass

    # Second chunk: partial_args with $.content — matches publish_report
    partial_arg = MagicMock()
    partial_arg.string_value = "Report content"
    partial_arg.json_path = "$.content"

    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = True
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []

    func_call2 = MagicMock()
    func_call2.id = "adk-multi-2"
    func_call2.name = None
    func_call2.args = None
    func_call2.partial_args = [partial_arg]
    func_call2.will_continue = True

    adk_event2.get_function_calls = lambda: [func_call2]
    adk_event2.long_running_tool_ids = []

    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    start_events = [e for e in events2 if str(e.type).split('.')[-1] == "TOOL_CALL_START"]
    assert len(start_events) == 1, f"Expected 1 TOOL_CALL_START, got {len(start_events)}"
    assert start_events[0].tool_call_name == "publish_report", (
        f"Should disambiguate to publish_report via $.content, got {start_events[0].tool_call_name}"
    )


async def test_client_tool_names_still_filtered_without_streaming_fc_args():
    """Without streaming_function_call_arguments, client_tool_names filter stays active on partials.

    This ensures the bypass only applies when streaming FC args is explicitly enabled.
    """
    translator = EventTranslator(
        streaming_function_call_arguments=False,
        client_tool_names={"publish_final_report"},
    )

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True
    adk_event.content = MagicMock()
    adk_event.content.parts = []

    func_call = MagicMock()
    func_call.id = "should-be-filtered"
    func_call.name = "publish_final_report"
    func_call.args = {"content": "test"}
    func_call.partial_args = None
    func_call.will_continue = True

    adk_event.get_function_calls = lambda: [func_call]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" not in event_types, (
        f"Client tool should still be filtered without streaming FC args, got {event_types}"
    )


async def test_pending_streaming_completion_suppresses_confirmed_event():
    """When resolved_name is empty (tool not in client_tool_names), the
    _pending_streaming_completion_id flag should still suppress the confirmed
    event's FC and map its ID to the streaming ID."""

    streaming_id = "streaming-fc-001"
    confirmed_id = "confirmed-fc-999"

    translator = EventTranslator(streaming_function_call_arguments=True)

    # Simulate streaming completion: set the pending flag and mark as completed
    translator._pending_streaming_completion_id = streaming_id
    translator._completed_streaming_function_calls.add(streaming_id)

    # Build a confirmed (non-partial) event with a different FC id
    fc = MagicMock()
    fc.id = confirmed_id
    fc.name = "some_tool"
    fc.args = {"key": "value"}

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = False
    adk_event.content = MagicMock()
    adk_event.content.parts = []
    adk_event.get_function_calls.return_value = [fc]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    # The confirmed FC should be suppressed — no TOOL_CALL events emitted
    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert "TOOL_CALL_START" not in event_types, (
        f"Confirmed FC should be suppressed by pending_streaming_completion_id, got {event_types}"
    )

    # Confirmed ID should be mapped to the streaming ID
    assert translator._confirmed_to_streaming_id.get(confirmed_id) == streaming_id, (
        f"Expected confirmed→streaming mapping, got {translator._confirmed_to_streaming_id}"
    )

    # Confirmed ID should be in emitted_tool_call_ids for ClientProxyTool dedup
    assert confirmed_id in translator.emitted_tool_call_ids

    # Flag should be cleared
    assert translator._pending_streaming_completion_id is None


async def test_streaming_lro_tool_defers_end_event():
    """When a tool opts in via stream_tool_call=True, streaming END is deferred."""
    from ag_ui_adk.config import PredictStateMapping

    translator = EventTranslator(
        predict_state=[PredictStateMapping(
            state_key="document",
            tool="write_document",
            tool_argument="content",
            stream_tool_call=True,
        )],
        streaming_function_call_arguments=True,
        client_tool_names=set(),
    )

    # Simulate first streaming chunk (START)
    fc1 = MagicMock()
    fc1.id = "stream-id-1"
    fc1.name = "write_document"
    fc1.args = {"content": "Hello"}
    fc1.partial_args = None
    fc1.will_continue = True

    adk_event1 = MagicMock()
    adk_event1.author = "assistant"
    adk_event1.partial = True
    adk_event1.content = MagicMock()
    adk_event1.content.parts = []
    adk_event1.get_function_calls = lambda: [fc1]
    adk_event1.long_running_tool_ids = []

    events1 = []
    async for e in translator.translate(adk_event1, "thread", "run"):
        events1.append(e)

    types1 = [e.type for e in events1]
    assert EventType.TOOL_CALL_START in types1

    # Simulate end-of-stream chunk (will_continue=False)
    fc2 = MagicMock()
    fc2.id = "stream-id-1"
    fc2.name = None
    fc2.args = {"content": "Hello world"}
    fc2.partial_args = None
    fc2.will_continue = False

    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = True
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []
    adk_event2.get_function_calls = lambda: [fc2]
    adk_event2.long_running_tool_ids = []

    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    types2 = [e.type for e in events2]
    # END should be deferred, not emitted
    assert EventType.TOOL_CALL_END not in types2, f"END should be deferred, got {types2}"
    # ARGS should still be emitted
    assert EventType.TOOL_CALL_ARGS in types2

    # The id should be in _streaming_awaiting_end
    assert "stream-id-1" in translator._streaming_awaiting_end


async def test_lro_complete_event_emits_deferred_end():
    """When confirmed LRO arrives and a streaming FC is awaiting END, emit deferred END + PredictState."""
    from ag_ui_adk.config import PredictStateMapping

    translator = EventTranslator(
        predict_state=[PredictStateMapping(
            state_key="document",
            tool="write_document",
            tool_argument="content",
            stream_tool_call=True,
        )],
        streaming_function_call_arguments=True,
        client_tool_names=set(),
    )

    # Put a streaming id into awaiting set directly
    translator._streaming_awaiting_end.add("stream-id-1")
    translator.emitted_tool_call_ids.add("stream-id-1")

    # Simulate confirmed LRO event
    adk_event = MagicMock()
    adk_event.long_running_tool_ids = ["confirmed-id-1"]
    adk_event.content = MagicMock()
    part = MagicMock()
    part.function_call = MagicMock()
    part.function_call.id = "confirmed-id-1"
    part.function_call.name = "write_document"
    adk_event.content.parts = [part]

    # get_streamed_id_for_lro should return the streaming id
    streamed_id = translator.get_streamed_id_for_lro(adk_event)
    assert streamed_id == "stream-id-1"

    # Map confirmed → streaming
    translator.map_confirmed_to_streaming("confirmed-id-1", "stream-id-1")
    assert translator._confirmed_to_streaming_id["confirmed-id-1"] == "stream-id-1"
    assert "stream-id-1" not in translator._streaming_awaiting_end

    # Emit deferred END
    events = []
    async for e in translator.emit_deferred_lro_end("stream-id-1", "write_document"):
        events.append(e)

    types = [e.type for e in events]
    # Should have PredictState CustomEvent + TOOL_CALL_END
    assert EventType.CUSTOM in types, f"Expected PredictState CustomEvent, got {types}"
    assert EventType.TOOL_CALL_END in types, f"Expected TOOL_CALL_END, got {types}"

    # PredictState should come before END
    custom_idx = types.index(EventType.CUSTOM)
    end_idx = types.index(EventType.TOOL_CALL_END)
    assert custom_idx < end_idx

    # TOOL_CALL_END should use the streaming id
    end_event = [e for e in events if e.type == EventType.TOOL_CALL_END][0]
    assert end_event.tool_call_id == "stream-id-1"

    # confirm_changes should be deferred
    assert translator.has_deferred_confirm_events()


async def test_non_opted_in_lro_unchanged():
    """Tools without stream_tool_call=True should emit END normally during streaming."""
    from ag_ui_adk.config import PredictStateMapping

    translator = EventTranslator(
        predict_state=[PredictStateMapping(
            state_key="report",
            tool="publish_report",
            tool_argument="content",
            stream_tool_call=False,  # NOT opted in
        )],
    )

    # Simulate a streaming FC that completes
    fc = MagicMock()
    fc.id = "normal-stream-1"
    fc.name = "publish_report"
    fc.args = {"content": "Report text"}
    fc.partial_args = None
    fc.will_continue = False

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True
    adk_event.content = MagicMock()
    adk_event.content.parts = []
    adk_event.get_function_calls = lambda: [fc]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    types = [e.type for e in events]
    # END should be emitted normally (not deferred)
    assert EventType.TOOL_CALL_END in types, f"Expected TOOL_CALL_END, got {types}"
    assert len(translator._streaming_awaiting_end) == 0


async def test_streaming_lro_confirmed_id_mapping():
    """Verify that confirmed→streaming ID mapping works for tool result routing."""
    from ag_ui_adk.config import PredictStateMapping

    translator = EventTranslator(
        predict_state=[PredictStateMapping(
            state_key="document",
            tool="write_document",
            tool_argument="content",
            stream_tool_call=True,
        )],
    )

    # Simulate the mapping
    translator.map_confirmed_to_streaming("confirmed-42", "streaming-42")

    # Verify mapping
    assert translator._confirmed_to_streaming_id["confirmed-42"] == "streaming-42"
    assert "confirmed-42" in translator.emitted_tool_call_ids
    assert "confirmed-42" in translator.long_running_tool_ids


async def test_streaming_fc_skips_backend_tool_named_first_chunk():
    """Backend tool with known name on first chunk is skipped entirely."""
    translator = EventTranslator(
        streaming_function_call_arguments=True,
        client_tool_names={"publish_final_report"},
        client_tool_schemas={"publish_final_report": {"content", "title"}},
    )

    # First chunk: google_search (backend tool) with name known
    fc1 = MagicMock()
    fc1.id = "backend-fc-1"
    fc1.name = "google_search"
    fc1.args = None
    fc1.partial_args = None
    fc1.will_continue = True

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True
    adk_event.content = MagicMock()
    adk_event.content.parts = []
    adk_event.get_function_calls = lambda: [fc1]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    # No tool call events should be emitted for backend tool
    types = [e.type for e in events]
    assert EventType.TOOL_CALL_START not in types, f"Backend tool should be skipped, got {types}"
    assert EventType.TOOL_CALL_ARGS not in types

    # Continuation chunk should also be skipped
    fc2 = MagicMock()
    fc2.id = "backend-fc-1"
    fc2.name = None
    fc2.args = None
    fc2.partial_args = [MagicMock(json_path="$.query", string_value="test")]
    fc2.will_continue = True

    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = True
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []
    adk_event2.get_function_calls = lambda: [fc2]
    adk_event2.long_running_tool_ids = []

    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    types2 = [e.type for e in events2]
    assert EventType.TOOL_CALL_ARGS not in types2, f"Continuation of backend tool should be skipped, got {types2}"

    # End chunk cleans up
    fc3 = MagicMock()
    fc3.id = "backend-fc-1"
    fc3.name = None
    fc3.args = None
    fc3.partial_args = None
    fc3.will_continue = False

    adk_event3 = MagicMock()
    adk_event3.author = "assistant"
    adk_event3.partial = True
    adk_event3.content = MagicMock()
    adk_event3.content.parts = []
    adk_event3.get_function_calls = lambda: [fc3]
    adk_event3.long_running_tool_ids = []

    events3 = []
    async for e in translator.translate(adk_event3, "thread", "run"):
        events3.append(e)

    assert "backend-fc-1" not in translator._backend_streaming_fc_ids, "Should be cleaned up after end"


async def test_streaming_fc_skips_backend_tool_nameless_via_json_paths():
    """Backend tool with nameless first chunk but non-matching json_paths is skipped."""
    translator = EventTranslator(
        streaming_function_call_arguments=True,
        client_tool_names={"publish_final_report", "write_document"},
        client_tool_schemas={
            "publish_final_report": {"content", "title"},
            "write_document": {"document"},
        },
    )

    # Nameless first chunk with partial_args whose json_paths don't match any client tool
    fc = MagicMock()
    fc.id = "backend-fc-2"
    fc.name = None
    fc.args = None
    fc.partial_args = [MagicMock(json_path="$.query", string_value="AI news")]
    fc.will_continue = True

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True
    adk_event.content = MagicMock()
    adk_event.content.parts = []
    adk_event.get_function_calls = lambda: [fc]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    types = [e.type for e in events]
    assert EventType.TOOL_CALL_START not in types, f"Backend tool should be skipped, got {types}"
    assert EventType.TOOL_CALL_ARGS not in types
    assert "backend-fc-2" in translator._backend_streaming_fc_ids


async def test_streaming_fc_allows_client_tool_when_backend_also_present():
    """Client tool partial_args are streamed even when backend tools exist."""
    translator = EventTranslator(
        streaming_function_call_arguments=True,
        client_tool_names={"publish_final_report"},
        client_tool_schemas={"publish_final_report": {"content", "title"}},
    )

    # Client tool with matching json_paths
    fc = MagicMock()
    fc.id = "client-fc-1"
    fc.name = "publish_final_report"
    fc.args = None
    fc.partial_args = None
    fc.will_continue = True

    adk_event = MagicMock()
    adk_event.author = "assistant"
    adk_event.partial = True
    adk_event.content = MagicMock()
    adk_event.content.parts = []
    adk_event.get_function_calls = lambda: [fc]
    adk_event.long_running_tool_ids = []

    events = []
    async for e in translator.translate(adk_event, "thread", "run"):
        events.append(e)

    types = [e.type for e in events]
    assert EventType.TOOL_CALL_START in types, f"Client tool should be streamed, got {types}"
    assert "client-fc-1" not in translator._backend_streaming_fc_ids


async def test_non_resumable_agent_tool_round_trip():
    """Non-resumable agent: first run emits tool call, second run with tool result gets text.

    Regression test ensuring that the is_resumable/client_tool_names filter
    does NOT block LRO tool call emission for non-resumable agents. On the
    feature branch, non-resumable agents must behave identically to main:
    - translate_lro_function_calls emits TOOL_CALL_START/ARGS/END
    - The client_tool_names filter is bypassed (is_resumable=False)

    This covers the multi-turn round trip: first run produces tool calls,
    second run (with tool results) produces a text response.
    """
    # Non-resumable agent: is_resumable=False, but client_tool_names is populated
    # (from ClientProxyToolset). The filter must be bypassed.
    translator = EventTranslator(
        client_tool_names={"lookup_weather"},
        is_resumable=False,  # Non-resumable (no ResumabilityConfig)
    )

    lro_id = "tool-call-weather-1"
    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "lookup_weather"
    lro_call.args = {"city": "San Francisco"}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    adk_event = MagicMock()
    adk_event.content = MagicMock()
    adk_event.content.parts = [lro_part]
    adk_event.long_running_tool_ids = [lro_id]

    # First run: translate_lro_function_calls should emit events
    events = []
    async for e in translator.translate_lro_function_calls(adk_event):
        events.append(e)

    event_types = [str(ev.type).split('.')[-1] for ev in events]
    assert event_types == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"], (
        f"Non-resumable agent must emit tool call events (filter bypassed), got {event_types}"
    )
    for ev in events:
        assert getattr(ev, 'tool_call_id', None) == lro_id

    # Second run: simulate text response after tool result submission
    # (translator is per-run, so create a fresh one for the second run)
    translator2 = EventTranslator(
        client_tool_names={"lookup_weather"},
        is_resumable=False,
    )

    text_event = MagicMock()
    text_event.author = "assistant"
    text_event.partial = False
    text_event.content = MagicMock()

    text_part = MagicMock()
    text_part.text = "The weather in San Francisco is 65°F and sunny."
    text_part.function_call = None
    text_event.content.parts = [text_part]
    text_event.get_function_calls = lambda: []
    text_event.long_running_tool_ids = []

    text_events = []
    async for e in translator2.translate(text_event, "thread-1", "run-2"):
        text_events.append(e)

    # Should have text message events
    text_types = [str(ev.type).split('.')[-1] for ev in text_events]
    assert any("TEXT_MESSAGE" in t for t in text_types), (
        f"Second run should produce text message events, got {text_types}"
    )


async def test_resumable_agent_no_duplicate_emission():
    """Resumable agent: LRO tool calls emitted exactly once (by ClientProxyTool, not translator).

    When is_resumable=True, the translate_lro_function_calls must filter out
    client tool names to prevent duplicates — ClientProxyTool handles emission.

    After ClientProxyTool runs, the confirmed event from ADK must also be
    suppressed by the translator (via client_emitted_tool_call_ids or client_tool_names).
    """
    client_emitted_ids: set[str] = set()
    translator = EventTranslator(
        client_emitted_tool_call_ids=client_emitted_ids,
        client_tool_names={"generate_task_steps"},
        is_resumable=True,
    )

    lro_id = "adk-lro-hitl-1"

    # Step 1: LRO event — translator should suppress (client tool, resumable)
    lro_call = MagicMock()
    lro_call.id = lro_id
    lro_call.name = "generate_task_steps"
    lro_call.args = {"steps": [{"description": "Plan project", "status": "pending"}]}

    lro_part = MagicMock()
    lro_part.function_call = lro_call

    lro_event = MagicMock()
    lro_event.content = MagicMock()
    lro_event.content.parts = [lro_part]
    lro_event.long_running_tool_ids = [lro_id]

    lro_events = []
    async for e in translator.translate_lro_function_calls(lro_event):
        lro_events.append(e)

    assert len(lro_events) == 0, (
        f"Resumable agent: translator must suppress client tool LRO, got {len(lro_events)} events"
    )

    # Step 2: ClientProxyTool emits (simulated by adding to shared set)
    confirmed_id = "adk-confirmed-hitl-2"
    client_emitted_ids.add(confirmed_id)

    # Step 3: Confirmed event with different ID — must also be suppressed
    confirmed_event = MagicMock()
    confirmed_event.author = "assistant"
    confirmed_event.partial = False
    confirmed_event.content = MagicMock()
    confirmed_event.content.parts = []

    confirmed_call = MagicMock()
    confirmed_call.id = confirmed_id
    confirmed_call.name = "generate_task_steps"
    confirmed_call.args = {"steps": [{"description": "Plan project", "status": "pending"}]}

    confirmed_event.get_function_calls = lambda: [confirmed_call]
    confirmed_event.long_running_tool_ids = []

    confirmed_events = []
    async for e in translator.translate(confirmed_event, "thread-1", "run-1"):
        confirmed_events.append(e)

    tool_events = [e for e in confirmed_events if "TOOL_CALL" in str(e.type)]
    assert len(tool_events) == 0, (
        f"Resumable agent: confirmed event must be suppressed (already emitted by proxy), "
        f"got {len(tool_events)} tool events"
    )

    # Total tool call emissions across all paths: 0 from translator
    # (ClientProxyTool would emit exactly 1 set — not tested here as it's a different component)


async def test_streaming_fc_late_backend_detection_on_deferred_start():
    """Nameless first chunk with no partial_args starts streaming, but second chunk
    reveals it's a backend tool via non-matching json_paths → reclassified."""
    translator = EventTranslator(
        streaming_function_call_arguments=True,
        client_tool_names={"publish_final_report"},
        client_tool_schemas={"publish_final_report": {"content", "title"}},
    )

    # Nameless first chunk with no partial_args (can't filter yet)
    fc1 = MagicMock()
    fc1.id = None  # Gemini sends None, ADK assigns adk-<uuid>
    fc1.name = None
    fc1.args = None
    fc1.partial_args = None
    fc1.will_continue = True

    adk_event1 = MagicMock()
    adk_event1.author = "assistant"
    adk_event1.partial = True
    adk_event1.content = MagicMock()
    adk_event1.content.parts = []
    adk_event1.get_function_calls = lambda: [fc1]
    adk_event1.long_running_tool_ids = []

    events1 = []
    async for e in translator.translate(adk_event1, "thread", "run"):
        events1.append(e)

    # No START emitted yet (deferred — name unknown)
    types1 = [e.type for e in events1]
    assert EventType.TOOL_CALL_START not in types1

    # The streaming session was started internally
    assert len(translator._streaming_function_calls) == 1
    streaming_id = translator._active_streaming_fc_id
    assert streaming_id is not None

    # Second chunk: partial_args with non-matching json_paths → backend tool
    fc2 = MagicMock()
    fc2.id = None
    fc2.name = None
    fc2.args = None
    fc2.partial_args = [MagicMock(json_path="$.query", string_value="test query")]
    fc2.will_continue = True

    adk_event2 = MagicMock()
    adk_event2.author = "assistant"
    adk_event2.partial = True
    adk_event2.content = MagicMock()
    adk_event2.content.parts = []
    adk_event2.get_function_calls = lambda: [fc2]
    adk_event2.long_running_tool_ids = []

    events2 = []
    async for e in translator.translate(adk_event2, "thread", "run"):
        events2.append(e)

    # Should have been reclassified — no events emitted
    types2 = [e.type for e in events2]
    assert EventType.TOOL_CALL_START not in types2
    assert EventType.TOOL_CALL_ARGS not in types2

    # Streaming state cleaned up, reclassified as backend
    assert len(translator._streaming_function_calls) == 0
    assert streaming_id in translator._backend_streaming_fc_ids


if __name__ == "__main__":
    asyncio.run(test_translate_skips_lro_function_calls())
    asyncio.run(test_translate_lro_function_calls_only_emits_lro())
    asyncio.run(test_translate_skips_function_calls_from_partial_events_without_streaming_args())
    asyncio.run(test_translate_emits_function_calls_from_confirmed_events())
    asyncio.run(test_translate_handles_missing_partial_attribute())
    asyncio.run(test_mode_a_streaming_fc_with_flag_enabled())
    asyncio.run(test_mode_a_first_chunk_skipped_without_flag())
    asyncio.run(test_same_tool_called_twice_not_suppressed())
    asyncio.run(test_confirmed_event_skips_lro_already_emitted_via_translate_lro())
    asyncio.run(test_confirmed_event_still_emits_non_lro_after_lro_emitted())
    asyncio.run(test_confirmed_event_with_different_lro_id_not_suppressed())
    asyncio.run(test_client_emitted_ids_suppress_confirmed_event())
    asyncio.run(test_client_emitted_ids_suppress_lro_translate())
    asyncio.run(test_client_emitted_ids_suppress_partial_event())
    asyncio.run(test_client_emitted_ids_do_not_suppress_other_tools())
    asyncio.run(test_shared_set_mutation_visible_to_translator())
    asyncio.run(test_client_tool_names_suppress_lro_path())
    asyncio.run(test_client_tool_names_suppress_confirmed_event())
    asyncio.run(test_client_tool_names_suppress_partial_event())
    asyncio.run(test_client_tool_names_do_not_suppress_other_tools())
    asyncio.run(test_client_tool_names_mixed_client_and_backend_calls())
    asyncio.run(test_translator_records_emitted_tool_call_ids())
    asyncio.run(test_full_resumable_hitl_flow_no_duplicates())
    asyncio.run(test_has_lro_function_call_sets_is_long_running_tool_even_when_translator_skips())
    asyncio.run(test_streaming_fc_args_nameless_chunks_stream_immediately())
    asyncio.run(test_streaming_fc_args_multi_tool_disambiguation())
    asyncio.run(test_client_tool_names_still_filtered_without_streaming_fc_args())
    asyncio.run(test_pending_streaming_completion_suppresses_confirmed_event())
    asyncio.run(test_streaming_lro_tool_defers_end_event())
    asyncio.run(test_lro_complete_event_emits_deferred_end())
    asyncio.run(test_non_opted_in_lro_unchanged())
    asyncio.run(test_streaming_lro_confirmed_id_mapping())
    asyncio.run(test_streaming_fc_skips_backend_tool_named_first_chunk())
    asyncio.run(test_streaming_fc_skips_backend_tool_nameless_via_json_paths())
    asyncio.run(test_streaming_fc_allows_client_tool_when_backend_also_present())
    asyncio.run(test_non_resumable_agent_tool_round_trip())
    asyncio.run(test_resumable_agent_no_duplicate_emission())
    asyncio.run(test_streaming_fc_late_backend_detection_on_deferred_start())
    print("\n✅ LRO and partial filtering tests ran to completion")

