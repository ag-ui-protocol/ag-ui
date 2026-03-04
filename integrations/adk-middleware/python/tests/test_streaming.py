#!/usr/bin/env python
"""Test the new streaming behavior with finish_reason detection."""

import asyncio
import logging
from pathlib import Path


from ag_ui_adk import EventTranslator

from unittest.mock import MagicMock

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(message)s')

class MockADKEvent:
    """Mock ADK event for testing."""
    def __init__(self, text_content, finish_reason=None):
        self.content = MagicMock()
        self.content.parts = [MagicMock(text=text_content)]
        self.author = "assistant"
        self.finish_reason = finish_reason  # Keep for test display

        # Mock candidates array for finish_reason detection
        if finish_reason == "STOP":
            self.candidates = [MagicMock(finish_reason="STOP")]
            self.partial = False
            self.turn_complete = True
            self.is_final_response = lambda: True
        else:
            self.candidates = [MagicMock(finish_reason=None)]
            self.partial = True
            self.turn_complete = False
            self.is_final_response = lambda: False

async def test_streaming_behavior():
    """Test that streaming works correctly with finish_reason."""
    print("🧪 Testing Streaming Behavior")
    print("=============================")

    translator = EventTranslator()

    # Simulate a streaming conversation
    adk_events = [
        MockADKEvent("Hello", None),           # First partial
        MockADKEvent(" there", None),          # Second partial
        MockADKEvent(", how", None),           # Third partial
        MockADKEvent(" are you", None),        # Fourth partial
        MockADKEvent(" today?", "STOP"),       # Final partial with STOP
    ]

    print("\n📡 Simulating ADK streaming events:")
    for i, event in enumerate(adk_events):
        print(f"  {i+1}. Text: '{event.content.parts[0].text}', finish_reason: {event.finish_reason}")

    print("\n🔄 Processing through EventTranslator:")
    print("-" * 50)

    all_events = []
    for adk_event in adk_events:
        events = []
        async for ag_ui_event in translator.translate(adk_event, "test_thread", "test_run"):
            events.append(ag_ui_event)
            all_events.append(ag_ui_event)

        print(f"ADK: '{adk_event.content.parts[0].text}' → {len(events)} AG-UI events")

    print("\n📊 Summary of Generated Events:")
    print("-" * 50)

    event_types = [event.type for event in all_events]
    for i, event in enumerate(all_events):
        if hasattr(event, 'delta'):
            print(f"  {i+1}. {event.type} - delta: '{event.delta}'")
        else:
            print(f"  {i+1}. {event.type}")

    # Verify correct sequence - the final event with STOP is skipped to avoid duplication
    # but triggers the END event, so we get 4 content events not 5
    expected_sequence = [
        "TEXT_MESSAGE_START",      # First event starts the message
        "TEXT_MESSAGE_CONTENT",    # Content: "Hello"
        "TEXT_MESSAGE_CONTENT",    # Content: " there"
        "TEXT_MESSAGE_CONTENT",    # Content: ", how"
        "TEXT_MESSAGE_CONTENT",    # Content: " are you"
        "TEXT_MESSAGE_END"         # Final event ends the message (triggered by STOP)
    ]

    # Convert enum types to strings for comparison
    event_type_strings = [str(event_type).split('.')[-1] for event_type in event_types]

    if event_type_strings == expected_sequence:
        print("\n✅ Perfect! Streaming sequence is correct:")
        print("   START → CONTENT → CONTENT → CONTENT → CONTENT → END")
        print("   Final event with STOP correctly triggers END (no duplicate content)")
        return True
    else:
        print(f"\n❌ Incorrect sequence!")
        print(f"   Expected: {expected_sequence}")
        print(f"   Got:      {event_type_strings}")
        return False

async def test_partial_with_finish_reason():
    """Test the specific scenario: partial=True, is_final_response=False, but finish_reason=STOP.

    This is the bug we fixed - Gemini returns partial=True even on the final chunk with finish_reason.
    The fix checks for finish_reason as a fallback to properly close the streaming message.
    """
    print("\n🧪 Testing Partial Event with finish_reason (Bug Fix Scenario)")
    print("=================================================================")

    translator = EventTranslator()

    # First event: start streaming
    first_event = MagicMock()
    first_event.content = MagicMock()
    first_event.content.parts = [MagicMock(text="Hello")]
    first_event.author = "assistant"
    first_event.partial = True
    first_event.turn_complete = None
    first_event.finish_reason = None
    first_event.is_final_response = lambda: False
    first_event.get_function_calls = lambda: []
    first_event.get_function_responses = lambda: []

    # Second event: final chunk with finish_reason BUT still partial=True (the bug scenario!)
    final_event = MagicMock()
    final_event.content = MagicMock()
    final_event.content.parts = [MagicMock(text=" world")]
    final_event.author = "assistant"
    final_event.partial = True  # Still marked as partial!
    final_event.turn_complete = None
    final_event.finish_reason = "STOP"  # But has finish_reason!
    final_event.is_final_response = lambda: False  # And is_final_response returns False!
    final_event.get_function_calls = lambda: []
    final_event.get_function_responses = lambda: []

    print("\n📡 Event 1: partial=True, finish_reason=None, is_final_response=False")
    print("📡 Event 2: partial=True, finish_reason=STOP, is_final_response=False ⚠️")

    all_events = []

    # Process first event
    async for ag_ui_event in translator.translate(first_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    # Process final event
    async for ag_ui_event in translator.translate(final_event, "test_thread", "test_run"):
        all_events.append(ag_ui_event)

    event_types = [str(event.type).split('.')[-1] for event in all_events]

    print(f"\n📊 Generated Events: {event_types}")

    # Expected: START, CONTENT (Hello), CONTENT (world), END
    # The fix ensures that finish_reason triggers END even when partial=True and is_final_response=False
    expected = ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]

    if event_types == expected:
        print("✅ Bug fix verified! finish_reason properly triggers TEXT_MESSAGE_END")
        print("   Even when partial=True and is_final_response=False")
        return True
    else:
        print(f"❌ Bug fix failed!")
        print(f"   Expected: {expected}")
        print(f"   Got:      {event_types}")
        return False

async def test_non_streaming():
    """Test that complete messages still work."""
    print("\n🧪 Testing Non-Streaming (Complete Messages)")
    print("============================================")

    translator = EventTranslator()

    # Single complete message - this will be detected as is_final_response=True
    # so it will only generate START and END (no content, content is skipped)
    complete_event = MockADKEvent("Hello, this is a complete message!", "STOP")

    events = []
    async for ag_ui_event in translator.translate(complete_event, "test_thread", "test_run"):
        events.append(ag_ui_event)

    event_types = [event.type for event in events]
    event_type_strings = [str(event_type).split('.')[-1] for event_type in event_types]

    # With a STOP finish_reason, the complete message is skipped to avoid duplication
    # but since there's no prior streaming, we just get END (or nothing if no prior stream)
    expected = ["TEXT_MESSAGE_END"]  # Only END event since is_final_response=True skips content

    if event_type_strings == expected:
        print("✅ Complete messages work correctly: END only (content skipped as final response)")
        return True
    elif len(event_type_strings) == 0:
        print("✅ Complete messages work correctly: No events (final response skipped entirely)")
        return True
    else:
        print(f"❌ Complete message failed: {event_type_strings}")
        return False

if __name__ == "__main__":
    async def run_tests():
        test1 = await test_streaming_behavior()
        test2 = await test_partial_with_finish_reason()
        test3 = await test_non_streaming()

        if test1 and test2 and test3:
            print("\n🎉 All streaming tests passed!")
            print("💡 Ready for real ADK integration with proper streaming")
        else:
            print("\n⚠️ Some tests failed")

    asyncio.run(run_tests())