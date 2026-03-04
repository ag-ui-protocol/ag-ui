#!/usr/bin/env python
"""Test Claude-specific streaming behavior.

This test simulates the event pattern that Claude models emit,
which differs from Gemini in several key ways:

1. Claude includes usage_metadata on ALL events, including streaming chunks
2. Claude sends a final consolidated event after streaming completes
3. The final event has partial=None (not False), turn_complete=None, is_final_response=True
4. The final event contains the FULL accumulated text (not a delta)

This is the bug scenario reported in GitHub issue #400.
"""

import asyncio
import logging
from unittest.mock import MagicMock

import pytest

from ag_ui_adk import EventTranslator
from ag_ui.core import EventType


class MockClaudeADKEvent:
    """Mock ADK event that simulates Claude's streaming behavior."""

    def __init__(
        self,
        text_content: str,
        partial: bool | None = True,
        turn_complete: bool | None = False,
        is_final: bool = False,
        usage_metadata: dict | None = None,
    ):
        self.content = MagicMock()
        self.content.parts = [MagicMock(text=text_content)]
        self.author = "assistant"
        self.partial = partial
        self.turn_complete = turn_complete
        self.finish_reason = None  # Claude doesn't use this during streaming
        self._is_final = is_final
        # Claude always includes usage metadata!
        self.usage_metadata = usage_metadata or {"tokens": 5}

    def is_final_response(self) -> bool:
        return self._is_final

    def get_function_calls(self):
        return []

    def get_function_responses(self):
        return []


@pytest.mark.asyncio
async def test_claude_streaming_with_final_consolidated_message():
    """Test Claude's streaming pattern: deltas + final consolidated message.

    Claude streams text in chunks, then sends a final event containing
    ALL the text. The middleware must detect and skip this duplicate.
    """
    translator = EventTranslator()

    # Claude streaming events (each contains incremental text with usage_metadata)
    streaming_events = [
        MockClaudeADKEvent("Hello", partial=True, turn_complete=False, usage_metadata={"tokens": 1}),
        MockClaudeADKEvent(" there", partial=True, turn_complete=False, usage_metadata={"tokens": 2}),
        MockClaudeADKEvent(", how", partial=True, turn_complete=False, usage_metadata={"tokens": 3}),
        MockClaudeADKEvent(" are you", partial=True, turn_complete=False, usage_metadata={"tokens": 4}),
        MockClaudeADKEvent("?", partial=True, turn_complete=True, usage_metadata={"tokens": 5}),
    ]

    # Claude's final consolidated message (contains FULL text, not a delta!)
    # This is the problematic event that causes duplication
    final_event = MockClaudeADKEvent(
        "Hello there, how are you?",  # Full text, not a delta!
        partial=None,  # Claude uses None, not False
        turn_complete=None,  # Claude uses None
        is_final=True,
        usage_metadata={"input_tokens": 10, "output_tokens": 8}  # Final usage stats
    )

    all_events = []

    # Process streaming events
    for adk_event in streaming_events:
        async for ag_ui_event in translator.translate(adk_event, "test_thread", "test_run"):
            all_events.append(ag_ui_event)
            print(f"Streaming: {ag_ui_event.type}")

    # Process final consolidated event
    async for ag_ui_event in translator.translate(final_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)
        print(f"Final: {ag_ui_event.type}")

    # Analyze results
    event_types = [event.type for event in all_events]
    content_events = [e for e in all_events if e.type == EventType.TEXT_MESSAGE_CONTENT]

    # We should have exactly 5 content events (one per streaming chunk)
    # NOT 6 (which would include the duplicate from final event)
    assert len(content_events) == 5, f"Expected 5 content events, got {len(content_events)}: {event_types}"

    # Verify the sequence
    expected_types = [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,  # "Hello"
        EventType.TEXT_MESSAGE_CONTENT,  # " there"
        EventType.TEXT_MESSAGE_CONTENT,  # ", how"
        EventType.TEXT_MESSAGE_CONTENT,  # " are you"
        EventType.TEXT_MESSAGE_CONTENT,  # "?"
        EventType.TEXT_MESSAGE_END,
    ]

    assert event_types == expected_types, f"Expected {expected_types}, got {event_types}"


@pytest.mark.asyncio
async def test_claude_streaming_closed_by_final_response():
    """Test that Claude's streaming is closed by the final consolidated event.

    Unlike Gemini (which ends streaming via partial=False + turn_complete=True),
    Claude keeps partial=True on all streaming chunks and only ends the stream
    when the final consolidated event arrives with is_final_response=True.

    This is the key difference that caused issue #400.
    """
    translator = EventTranslator()

    # Start streaming - both chunks have partial=True
    first_event = MockClaudeADKEvent("Hello", partial=True, turn_complete=False)
    second_event = MockClaudeADKEvent(" world", partial=True, turn_complete=False)

    all_events = []
    async for ag_ui_event in translator.translate(first_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    # Verify we started streaming
    assert translator._is_streaming is True

    async for ag_ui_event in translator.translate(second_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    # Streaming should STILL be active (Claude keeps partial=True)
    assert translator._is_streaming is True

    # Now send final consolidated event with partial=None and is_final=True
    # This is what ends the stream for Claude
    final_event = MockClaudeADKEvent(
        "Hello world",  # Full text (would be duplicate)
        partial=None,  # Claude uses None on final event
        turn_complete=None,
        is_final=True
    )

    async for ag_ui_event in translator.translate(final_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    # Now streaming should be ended (by final_response)
    assert translator._is_streaming is False

    # Verify we got: START, CONTENT("Hello"), CONTENT(" world"), END
    # The final consolidated "Hello world" should NOT create additional CONTENT
    event_types = [e.type for e in all_events]
    expected = [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,  # "Hello"
        EventType.TEXT_MESSAGE_CONTENT,  # " world"
        EventType.TEXT_MESSAGE_END,
    ]
    assert event_types == expected, f"Expected {expected}, got {event_types}"


@pytest.mark.asyncio
async def test_claude_non_streaming_single_response():
    """Test Claude's non-streaming mode (single complete response).

    When Claude doesn't stream (e.g., small responses), it sends a single
    event with is_final_response=True. This should generate START/CONTENT/END.
    """
    translator = EventTranslator()

    # Single non-streamed response
    single_event = MockClaudeADKEvent(
        "Hello, I'm Claude!",
        partial=None,  # Non-streaming uses None
        turn_complete=None,
        is_final=True,
        usage_metadata={"input_tokens": 10, "output_tokens": 5}
    )

    all_events = []
    async for ag_ui_event in translator.translate(single_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    event_types = [event.type for event in all_events]

    # Non-streaming should produce START, CONTENT, END
    expected = [
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
    ]

    assert event_types == expected, f"Expected {expected}, got {event_types}"


@pytest.mark.asyncio
async def test_claude_repeated_runs_no_duplicate():
    """Test that repeated runs don't cause duplicate content.

    This simulates the issue from GitHub #400 where messages were repeating.
    """
    translator = EventTranslator()

    # First run - stream some content
    first_run_events = [
        MockClaudeADKEvent("First", partial=True, turn_complete=False),
        MockClaudeADKEvent(" response", partial=True, turn_complete=True),
    ]

    all_events = []
    for adk_event in first_run_events:
        async for ag_ui_event in translator.translate(adk_event, "test_thread", "run_1"):
            all_events.append(ag_ui_event)

    # Final consolidated for first run
    final_1 = MockClaudeADKEvent("First response", partial=None, is_final=True)
    async for ag_ui_event in translator.translate(final_1, "test_thread", "run_1"):
        all_events.append(ag_ui_event)

    first_run_count = len(all_events)

    # Reset translator for second run (simulates a new conversation turn)
    translator.reset()

    # Second run - different content
    second_run_events = [
        MockClaudeADKEvent("Second", partial=True, turn_complete=False),
        MockClaudeADKEvent(" reply", partial=True, turn_complete=True),
    ]

    for adk_event in second_run_events:
        async for ag_ui_event in translator.translate(adk_event, "test_thread", "run_2"):
            all_events.append(ag_ui_event)

    # Final consolidated for second run
    final_2 = MockClaudeADKEvent("Second reply", partial=None, is_final=True)
    async for ag_ui_event in translator.translate(final_2, "test_thread", "run_2"):
        all_events.append(ag_ui_event)

    second_run_count = len(all_events) - first_run_count

    # Both runs should have same number of events (no duplicates)
    # Each run: START, 2x CONTENT, END = 4 events
    expected_per_run = 4  # START + 2 CONTENT + END

    assert first_run_count == expected_per_run, f"First run: expected {expected_per_run}, got {first_run_count}"
    assert second_run_count == expected_per_run, f"Second run: expected {expected_per_run}, got {second_run_count}"


@pytest.mark.asyncio
async def test_claude_accumulated_text_in_chunks():
    """Test Claude sending accumulated text in each chunk (not deltas).

    Some LLM providers send the FULL accumulated text in each streaming chunk,
    not just the delta. This test verifies we handle this correctly.

    For example:
    - Chunk 1: "Hello"
    - Chunk 2: "Hello there" (full text, not just " there")
    - Chunk 3: "Hello there!" (full text)
    - Final: "Hello there!" (same as last chunk)
    """
    translator = EventTranslator()

    # Each chunk contains the FULL accumulated text (bad behavior, but we should handle it)
    chunk_events = [
        MockClaudeADKEvent("Hello", partial=True, turn_complete=False),
        MockClaudeADKEvent("Hello there", partial=True, turn_complete=False),  # Full text!
        MockClaudeADKEvent("Hello there!", partial=True, turn_complete=False),  # Full text!
    ]

    all_events = []
    for adk_event in chunk_events:
        async for ag_ui_event in translator.translate(adk_event, "test_thread", "test_run"):
            all_events.append(ag_ui_event)

    # Final consolidated event
    final_event = MockClaudeADKEvent(
        "Hello there!",
        partial=None,
        turn_complete=None,
        is_final=True
    )

    async for ag_ui_event in translator.translate(final_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    # Count content events - we'll get 3 (one per chunk) + no extra from final
    content_events = [e for e in all_events if e.type == EventType.TEXT_MESSAGE_CONTENT]

    # This is actually OK because the middleware just forwards what it receives
    # The issue is that the UI will see accumulated text, not deltas
    # But at least we shouldn't create EXTRA duplicates from the final event
    assert len(content_events) == 3, f"Expected 3 content events, got {len(content_events)}"

    # Verify no START/CONTENT/END sequence from the final event
    event_types = [e.type for e in all_events]
    # Should be START, CONTENT, CONTENT, CONTENT, END (not START, CONTENT x4, END)
    assert event_types.count(EventType.TEXT_MESSAGE_START) == 1, "Should only have one START"
    assert event_types.count(EventType.TEXT_MESSAGE_END) == 1, "Should only have one END"


@pytest.mark.asyncio
async def test_claude_accumulated_text_with_early_stream_end():
    """Test the likely bug scenario: accumulated text + stream ends before final.

    If Claude sends accumulated text (not deltas) in each chunk,
    AND the stream ends via finish_reason BEFORE the final consolidated event,
    the duplicate detection will FAIL because:

    - _last_streamed_text = accumulated "HelloHello thereHello there!"
    - final event has = "Hello there!"
    - These don't match, so duplicate check fails
    - Result: extra START/CONTENT/END sequence is emitted = DUPLICATE MESSAGES

    This is the likely root cause of GitHub issue #400.
    """
    translator = EventTranslator()

    # Accumulated text pattern (each chunk has full text so far)
    chunk1 = MockClaudeADKEvent("Hello", partial=True, turn_complete=False)
    chunk2 = MockClaudeADKEvent("Hello there", partial=True, turn_complete=False)  # Full text!
    chunk3 = MockClaudeADKEvent("Hello there!", partial=True, turn_complete=False)  # Full text!

    # Final streaming chunk ends the stream via finish_reason
    final_chunk = MockClaudeADKEvent("Hello there!", partial=True, turn_complete=False)
    final_chunk.finish_reason = "STOP"

    all_events = []

    for adk_event in [chunk1, chunk2, chunk3]:
        async for ag_ui_event in translator.translate(adk_event, "test_thread", "test_run"):
            all_events.append(ag_ui_event)

    # Check what _current_stream_text is
    accumulated = translator._current_stream_text
    print(f"Accumulated text: '{accumulated}'")  # Will be "HelloHello thereHello there!"

    async for ag_ui_event in translator.translate(final_chunk, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    # Stream has ended
    assert translator._is_streaming is False
    saved_text = translator._last_streamed_text
    print(f"Saved text: '{saved_text}'")  # Will be "HelloHello thereHello there!Hello there!"

    # Final consolidated event
    final_event = MockClaudeADKEvent(
        "Hello there!",  # The correct final text
        partial=None,
        turn_complete=None,
        is_final=True
    )

    events_before = len(all_events)
    async for ag_ui_event in translator.translate(final_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)
    events_after = len(all_events)

    new_events = events_after - events_before

    # BUG: This will likely FAIL if Claude sends accumulated text
    # The duplicate detection compares "Hello there!" vs accumulated mess
    # and they won't match, so extra events are generated
    if new_events > 0:
        print(f"BUG DETECTED: {new_events} extra events from final consolidated message")
        new_event_types = [e.type for e in all_events[events_before:]]
        print(f"Extra events: {new_event_types}")

    # This assertion documents the expected (fixed) behavior
    # Currently this might fail, revealing the bug
    assert new_events == 0, f"Final event should be skipped (duplicate), but generated {new_events} events: this is the bug from issue #400"


@pytest.mark.asyncio
async def test_claude_stream_ended_before_final():
    """Test the scenario from @SleeperSmith's debug output.

    Debug showed: currently_streaming=False when final event arrived.
    This means the stream ended before the final consolidated event.

    This could happen if:
    1. An earlier event had finish_reason set
    2. Some other mechanism ended the stream
    """
    translator = EventTranslator()

    # Streaming events
    chunk_events = [
        MockClaudeADKEvent("Hello", partial=True, turn_complete=False),
        MockClaudeADKEvent(" there", partial=True, turn_complete=False),
    ]

    # Last streaming chunk with finish_reason (but still partial=True)
    # This triggers should_send_end via has_finish_reason
    final_chunk = MockClaudeADKEvent("!", partial=True, turn_complete=False)
    final_chunk.finish_reason = "STOP"  # This ends streaming

    all_events = []

    for adk_event in chunk_events:
        async for ag_ui_event in translator.translate(adk_event, "test_thread", "test_run"):
            all_events.append(ag_ui_event)

    async for ag_ui_event in translator.translate(final_chunk, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    # Streaming should have ended via finish_reason
    assert translator._is_streaming is False, "Streaming should have ended via finish_reason"

    # Final consolidated event arrives AFTER streaming ended
    final_event = MockClaudeADKEvent(
        "Hello there!",  # Full text
        partial=None,
        turn_complete=None,
        is_final=True
    )

    events_before = len(all_events)
    async for ag_ui_event in translator.translate(final_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)
    events_after = len(all_events)

    # The final event should be detected as duplicate and skipped
    new_events = events_after - events_before
    assert new_events == 0, f"Final event should be skipped (duplicate), but generated {new_events} events"


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(test_claude_streaming_with_final_consolidated_message())
    asyncio.run(test_claude_streaming_closed_by_final_response())
    asyncio.run(test_claude_non_streaming_single_response())
    asyncio.run(test_claude_repeated_runs_no_duplicate())
    asyncio.run(test_claude_accumulated_text_in_chunks())
    asyncio.run(test_claude_stream_ended_before_final())
    print("\n✅ All Claude streaming tests passed!")
