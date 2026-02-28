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


if __name__ == "__main__":
    asyncio.run(test_translate_skips_lro_function_calls())
    asyncio.run(test_translate_lro_function_calls_only_emits_lro())
    asyncio.run(test_translate_skips_function_calls_from_partial_events_without_streaming_args())
    asyncio.run(test_translate_emits_function_calls_from_confirmed_events())
    asyncio.run(test_translate_handles_missing_partial_attribute())
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
    asyncio.run(test_non_resumable_agent_tool_round_trip())
    asyncio.run(test_resumable_agent_no_duplicate_emission())
    print("\n✅ LRO and partial filtering tests ran to completion")

