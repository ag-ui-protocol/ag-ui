#!/usr/bin/env python
"""Tests for skip_summarization scenarios.

These tests verify that when skip_summarization=True is set in ADK tool_context.actions,
the middleware correctly:
1. Does NOT emit empty TextMessageContentEvent (which would cause validation errors)
2. Still emits ToolCallResultEvent for backend tool results
3. Properly closes active streams before emitting tool results
"""

import pytest
from types import SimpleNamespace
from typing import List
from unittest.mock import MagicMock, Mock

from ag_ui.core import (
    EventType,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallResultEvent,
)
from google.adk.events import Event as ADKEvent
from ag_ui_adk.event_translator import EventTranslator


class TestSkipSummarizationScenarios:
    """Tests for skip_summarization behavior in EventTranslator."""

    @pytest.fixture
    def translator(self):
        """Create a fresh EventTranslator instance."""
        return EventTranslator()

    def _create_function_response(self, tool_call_id: str, response: dict):
        """Helper to create a function response object."""
        return SimpleNamespace(id=tool_call_id, response=response)

    def _create_adk_event(
        self,
        *,
        text_parts: List[str] = None,
        function_responses: List = None,
        is_final_response: bool = False,
        partial: bool = False,
        turn_complete: bool = True,
        author: str = "model",
    ):
        """Helper to create a mock ADK event.

        Args:
            text_parts: List of text strings for content parts. None or empty = no text.
            function_responses: List of function response objects.
            is_final_response: Whether this is a final response.
            partial: Whether this is a partial/streaming event.
            turn_complete: Whether the turn is complete.
            author: Event author ("model" or "user").
        """
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = author
        event.partial = partial
        event.turn_complete = turn_complete
        event.finish_reason = "STOP" if is_final_response else None
        event.actions = None
        event.custom_data = None
        event.long_running_tool_ids = []

        # Set up is_final_response
        event.is_final_response = Mock(return_value=is_final_response)

        # Set up content with text parts
        if text_parts:
            mock_parts = [MagicMock(text=t) for t in text_parts]
            mock_content = MagicMock()
            mock_content.parts = mock_parts
            event.content = mock_content
        else:
            # Empty or no content
            mock_content = MagicMock()
            mock_content.parts = []
            event.content = mock_content

        # Set up function calls/responses
        event.get_function_calls = Mock(return_value=[])
        event.get_function_responses = Mock(return_value=function_responses or [])

        return event

    # =========================================================================
    # POSITIVE TESTS: ToolCallResultEvent should be emitted
    # =========================================================================

    @pytest.mark.asyncio
    async def test_skip_summarization_emits_tool_result_no_text(self, translator):
        """Test: skip_summarization with function responses emits ToolCallResultEvent, no text events.

        When skip_summarization=True, the model returns a final response with:
        - No text content (empty or no text parts)
        - Function responses containing the tool result

        Expected: ToolCallResultEvent emitted, no TextMessage* events.
        """
        func_response = self._create_function_response(
            tool_call_id="tool-123",
            response={"success": True, "data": "result"}
        )

        event = self._create_adk_event(
            text_parts=[],  # No text (skip_summarization)
            function_responses=[func_response],
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Should have exactly one ToolCallResultEvent
        tool_results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 1
        assert tool_results[0].tool_call_id == "tool-123"

        # Should NOT have any text message events
        text_starts = [e for e in events if isinstance(e, TextMessageStartEvent)]
        text_contents = [e for e in events if isinstance(e, TextMessageContentEvent)]
        text_ends = [e for e in events if isinstance(e, TextMessageEndEvent)]

        assert len(text_starts) == 0, "Should not emit TextMessageStartEvent"
        assert len(text_contents) == 0, "Should not emit TextMessageContentEvent"
        assert len(text_ends) == 0, "Should not emit TextMessageEndEvent"

    @pytest.mark.asyncio
    async def test_skip_summarization_closes_active_stream_emits_tool_result(self, translator):
        """Test: skip_summarization with active stream - caller must close stream, ToolCallResultEvent emitted.

        Scenario:
        1. First event starts a text stream
        2. Second event is final response with skip_summarization (no text, has function response)

        When content.parts is empty, translate() does NOT call _translate_text_content,
        so streams are not closed by translate() itself. The caller (adk_agent.py) is
        responsible for calling force_close_streaming_message() at the end of the run.

        Expected:
        - ToolCallResultEvent emitted by translate()
        - Stream closed by explicit call to force_close_streaming_message()
        """
        # First event: start streaming
        stream_event = self._create_adk_event(
            text_parts=["Starting response..."],
            function_responses=[],
            is_final_response=False,
            partial=True,
            turn_complete=False,
        )

        # Translate first event to start the stream
        events1 = []
        async for e in translator.translate(stream_event, "thread_1", "run_1"):
            events1.append(e)

        # Verify stream started
        assert any(isinstance(e, TextMessageStartEvent) for e in events1)
        assert any(isinstance(e, TextMessageContentEvent) for e in events1)
        assert translator._is_streaming is True

        # Second event: final response with skip_summarization
        func_response = self._create_function_response(
            tool_call_id="tool-456",
            response={"completed": True}
        )

        final_event = self._create_adk_event(
            text_parts=[],  # No text (skip_summarization)
            function_responses=[func_response],
            is_final_response=True,
            partial=False,
            turn_complete=True,
        )

        events2 = []
        async for e in translator.translate(final_event, "thread_1", "run_1"):
            events2.append(e)

        # ToolCallResultEvent should be emitted
        tool_results = [e for e in events2 if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 1, "ToolCallResultEvent must be emitted even with active stream"
        assert tool_results[0].tool_call_id == "tool-456"

        # Stream is NOT closed by translate() when content.parts is empty
        # This is by design - caller (adk_agent.py) calls force_close_streaming_message()
        assert translator._is_streaming is True, "Stream still open after translate()"

        # Caller must explicitly close the stream (simulating adk_agent.py behavior)
        close_events = []
        async for e in translator.force_close_streaming_message():
            close_events.append(e)

        # Now stream should be closed
        end_events = [e for e in close_events if isinstance(e, TextMessageEndEvent)]
        assert len(end_events) == 1, "force_close_streaming_message() should close the stream"
        assert translator._is_streaming is False

    @pytest.mark.asyncio
    async def test_event_with_both_text_and_function_responses(self, translator):
        """Test: Event with both text and function responses emits both correctly.

        This is a normal scenario (not skip_summarization) where the model returns
        both a text response AND function responses.
        """
        func_response = self._create_function_response(
            tool_call_id="tool-789",
            response={"value": 42}
        )

        event = self._create_adk_event(
            text_parts=["Here is the result from the tool."],
            function_responses=[func_response],
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Should have text message events
        text_starts = [e for e in events if isinstance(e, TextMessageStartEvent)]
        text_contents = [e for e in events if isinstance(e, TextMessageContentEvent)]
        text_ends = [e for e in events if isinstance(e, TextMessageEndEvent)]

        assert len(text_starts) == 1
        assert len(text_contents) == 1
        assert text_contents[0].delta == "Here is the result from the tool."
        assert len(text_ends) == 1

        # Should also have ToolCallResultEvent
        tool_results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 1
        assert tool_results[0].tool_call_id == "tool-789"

    @pytest.mark.asyncio
    async def test_multiple_function_responses_all_emitted(self, translator):
        """Test: Multiple function responses in skip_summarization all emit ToolCallResultEvent."""
        func_responses = [
            self._create_function_response("tool-1", {"result": "a"}),
            self._create_function_response("tool-2", {"result": "b"}),
            self._create_function_response("tool-3", {"result": "c"}),
        ]

        event = self._create_adk_event(
            text_parts=[],  # No text (skip_summarization)
            function_responses=func_responses,
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Should have three ToolCallResultEvents
        tool_results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 3

        tool_ids = {r.tool_call_id for r in tool_results}
        assert tool_ids == {"tool-1", "tool-2", "tool-3"}

    # =========================================================================
    # NEGATIVE TESTS: Ensure no invalid events are emitted
    # =========================================================================

    @pytest.mark.asyncio
    async def test_skip_summarization_empty_function_responses_no_events(self, translator):
        """Test: skip_summarization with empty function responses emits nothing.

        Edge case where skip_summarization is set but there are no function responses.
        Should not emit any events.
        """
        event = self._create_adk_event(
            text_parts=[],  # No text
            function_responses=[],  # No function responses
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Should have no events at all
        assert len(events) == 0, f"Expected no events, got: {[type(e).__name__ for e in events]}"

    @pytest.mark.asyncio
    async def test_skip_summarization_does_not_emit_empty_text_content(self, translator):
        """Test: skip_summarization does NOT emit TextMessageContentEvent with empty delta.

        This is the core validation issue from GitHub #765. Empty delta would cause
        Pydantic validation error: "String should have at least 1 character".
        """
        event = self._create_adk_event(
            text_parts=[""],  # Empty string text part
            function_responses=[],
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Should NOT have any TextMessageContentEvent with empty delta
        text_contents = [e for e in events if isinstance(e, TextMessageContentEvent)]
        for tc in text_contents:
            assert tc.delta, f"TextMessageContentEvent should not have empty delta: {tc}"

    @pytest.mark.asyncio
    async def test_empty_final_response_no_function_responses_no_events(self, translator):
        """Test: Empty final response with no function responses emits nothing.

        A final response with no content and no function responses should not
        emit any events.
        """
        event = self._create_adk_event(
            text_parts=None,  # No content parts at all
            function_responses=[],
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_whitespace_only_text_not_filtered(self, translator):
        """Test: Whitespace-only text IS valid and should be emitted.

        Unlike empty string, whitespace is valid text content.
        """
        event = self._create_adk_event(
            text_parts=["   "],  # Whitespace only
            function_responses=[],
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Whitespace should be emitted
        text_contents = [e for e in events if isinstance(e, TextMessageContentEvent)]
        assert len(text_contents) == 1
        assert text_contents[0].delta == "   "

    @pytest.mark.asyncio
    async def test_mixed_empty_and_valid_text_parts(self, translator):
        """Test: Mixed empty and valid text parts - only valid parts emitted."""
        event = self._create_adk_event(
            text_parts=["", "Valid text", ""],  # Mix of empty and valid
            function_responses=[],
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Should have text content with only the valid text
        text_contents = [e for e in events if isinstance(e, TextMessageContentEvent)]
        assert len(text_contents) == 1
        assert text_contents[0].delta == "Valid text"

    # =========================================================================
    # EDGE CASES
    # =========================================================================

    @pytest.mark.asyncio
    async def test_function_response_parts_in_content_no_text_events(self, translator):
        """Test: Event with function_response parts in content (no text) emits no text events.

        When skip_summarization is true, content.parts might contain function_response
        parts but no text parts. Ensure no text events are emitted.
        """
        # Create event with content that has parts, but the parts have no text
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = "model"
        event.partial = False
        event.turn_complete = True
        event.finish_reason = "STOP"
        event.actions = None
        event.custom_data = None
        event.long_running_tool_ids = []
        event.is_final_response = Mock(return_value=True)

        # Content has parts, but they're function_response parts (no .text attribute)
        mock_part = MagicMock()
        mock_part.text = None  # No text attribute
        mock_part.function_response = SimpleNamespace(id="tool-x", response={"ok": True})

        mock_content = MagicMock()
        mock_content.parts = [mock_part]
        event.content = mock_content

        func_response = self._create_function_response("tool-x", {"ok": True})
        event.get_function_calls = Mock(return_value=[])
        event.get_function_responses = Mock(return_value=[func_response])

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Should NOT have text events
        text_events = [e for e in events if isinstance(e, (
            TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent
        ))]
        assert len(text_events) == 0, f"Should not emit text events, got: {text_events}"

        # Should have ToolCallResultEvent
        tool_results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 1
        assert tool_results[0].tool_call_id == "tool-x"

    @pytest.mark.asyncio
    async def test_non_final_response_with_function_responses(self, translator):
        """Test: Non-final response with function responses still emits ToolCallResultEvent.

        Even if is_final_response=False, function responses should be emitted.
        """
        func_response = self._create_function_response("tool-nf", {"status": "ok"})

        event = self._create_adk_event(
            text_parts=[],
            function_responses=[func_response],
            is_final_response=False,  # Not final
            partial=False,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        tool_results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 1
        assert tool_results[0].tool_call_id == "tool-nf"

    @pytest.mark.asyncio
    async def test_lro_tool_responses_not_emitted(self, translator):
        """Test: Long-running tool responses are NOT emitted as ToolCallResultEvent.

        LRO tools are handled by the frontend, so their results should be skipped.
        """
        lro_tool_id = "lro-tool-123"
        translator.long_running_tool_ids.append(lro_tool_id)

        func_response = self._create_function_response(lro_tool_id, {"result": "x"})

        event = self._create_adk_event(
            text_parts=[],
            function_responses=[func_response],
            is_final_response=True,
            turn_complete=True,
        )

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Should NOT have ToolCallResultEvent for LRO tool
        tool_results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 0

    @pytest.mark.asyncio
    async def test_early_return_at_line_380_still_emits_tool_result(self, translator):
        """Test: When _translate_text_content returns early (line 380-385), ToolCallResultEvent still emits.

        This specifically tests the scenario where:
        1. is_final_response=True
        2. No active stream
        3. No text content (combined_text is empty)
        4. Returns early at line 380-385

        The ToolCallResultEvent should still be emitted because translate() continues
        to the function response handling after _translate_text_content returns.
        """
        func_response = self._create_function_response(
            tool_call_id="tool-early-return",
            response={"test": "value"}
        )

        # This event will trigger the early return at line 380-385
        event = self._create_adk_event(
            text_parts=[],  # No text, but content.parts exists (empty list)
            function_responses=[func_response],
            is_final_response=True,
            partial=False,
            turn_complete=True,
        )

        # Ensure content.parts is truthy but contains no text
        # This ensures _translate_text_content is called but returns early
        mock_content = MagicMock()
        mock_content.parts = [MagicMock(text=None)]  # Parts exist but no text
        event.content = mock_content

        events = []
        async for e in translator.translate(event, "thread_1", "run_1"):
            events.append(e)

        # Despite early return in text handling, ToolCallResultEvent should be emitted
        tool_results = [e for e in events if isinstance(e, ToolCallResultEvent)]
        assert len(tool_results) == 1, (
            f"ToolCallResultEvent should be emitted even when text handling returns early. "
            f"Got events: {[type(e).__name__ for e in events]}"
        )
        assert tool_results[0].tool_call_id == "tool-early-return"

        # No text events should be emitted
        text_contents = [e for e in events if isinstance(e, TextMessageContentEvent)]
        assert len(text_contents) == 0
