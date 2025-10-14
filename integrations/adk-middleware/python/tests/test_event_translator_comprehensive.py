#!/usr/bin/env python
"""Comprehensive tests for EventTranslator, focusing on untested paths."""

import json
from dataclasses import asdict, dataclass
from types import SimpleNamespace
from typing import Optional

import pytest
import uuid
from unittest.mock import MagicMock, patch, AsyncMock

from ag_ui.core import (
    EventType, TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent,
    StateDeltaEvent, CustomEvent
)
from google.adk.events import Event as ADKEvent
from ag_ui_adk.event_translator import EventTranslator


class TestEventTranslatorComprehensive:
    """Comprehensive tests for EventTranslator functionality."""

    @pytest.fixture
    def translator(self):
        """Create a fresh EventTranslator instance."""
        return EventTranslator()

    @pytest.fixture
    def mock_adk_event(self):
        """Create a mock ADK event."""
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = "model"
        event.content = None
        event.partial = False
        event.turn_complete = True
        event.is_final_response = False
        return event

    @pytest.fixture
    def mock_adk_event_with_content(self):
        """Create a mock ADK event with content."""
        event = MagicMock(spec=ADKEvent)
        event.id = "test_event_id"
        event.author = "model"

        # Mock content with text parts
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Test content"
        mock_content.parts = [mock_part]
        event.content = mock_content

        event.partial = False
        event.turn_complete = True
        event.is_final_response = False
        event.usage_metadata = {'tokens': 22}
        return event

    @pytest.mark.asyncio
    async def test_translate_user_event_skipped(self, translator, mock_adk_event):
        """Test that user events are skipped."""
        mock_adk_event.author = "user"

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_event_without_content(self, translator, mock_adk_event):
        """Test translating event without content."""
        mock_adk_event.content = None

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_event_with_empty_parts(self, translator, mock_adk_event):
        """Test translating event with empty parts."""
        mock_content = MagicMock()
        mock_content.parts = []
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_function_calls_detection(self, translator, mock_adk_event):
        """Test that function calls produce ToolCall events."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.id = "call_123"
        mock_function_call.args = {"param": "value"}
        mock_adk_event.get_function_calls = MagicMock(return_value=[mock_function_call])

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        type_names = [str(event.type).split('.')[-1] for event in events]
        assert type_names == ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]
        ids = [getattr(event, 'tool_call_id', None) for event in events]
        assert ids == ["call_123", "call_123", "call_123"]

    @pytest.mark.asyncio
    async def test_translate_function_responses_handling(self, translator, mock_adk_event):
        """Test function responses handling."""
        # Mock event with function responses
        function_response = SimpleNamespace(id="tool-1", response={"ok": True})
        mock_adk_event.get_function_calls = MagicMock(return_value=[])
        mock_adk_event.get_function_responses = MagicMock(return_value=[function_response])

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ToolCallResultEvent)
        assert json.loads(event.content) == {"ok": True}

    @pytest.mark.asyncio
    async def test_translate_function_response_with_call_tool_result_payload(self, translator):
        """Ensure complex CallToolResult payloads are serialized correctly."""

        @dataclass
        class TextContent:
            type: str = "text"
            text: str = ""
            annotations: Optional[list] = None
            meta: Optional[dict] = None

        @dataclass
        class CallToolResult:
            meta: Optional[dict]
            structuredContent: Optional[dict]
            isError: bool
            content: list[TextContent]

        repeated_text_entries = [
            "Primary Task: Provide a detailed walkthrough for the requested topic.",
            "Primary Task: Provide a detailed walkthrough for the requested topic.",
            "Constraints: Ensure clarity and maintain a concise explanation.",
            "Constraints: Ensure clarity and maintain a concise explanation.",
        ]

        payload = CallToolResult(
            meta=None,
            structuredContent=None,
            isError=False,
            content=[TextContent(text=text) for text in repeated_text_entries],
        )

        function_response = SimpleNamespace(
            id="tool-structured-1",
            response={"result": payload},
        )

        events = []
        async for event in translator._translate_function_response([function_response]):
            events.append(event)

        assert len(events) == 1
        event = events[0]
        assert isinstance(event, ToolCallResultEvent)

        content = json.loads(event.content)
        assert content["result"]["isError"] is False
        assert content["result"]["structuredContent"] is None
        assert [item["text"] for item in content["result"]["content"]] == repeated_text_entries

    @pytest.mark.asyncio
    async def test_translate_state_delta_event(self, translator, mock_adk_event):
        """Test state delta event creation."""
        # Mock event with state delta
        mock_actions = MagicMock()
        mock_actions.state_delta = {"key1": "value1", "key2": "value2"}
        mock_adk_event.actions = mock_actions

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1
        assert isinstance(events[0], StateDeltaEvent)
        assert events[0].type == EventType.STATE_DELTA

        # Check patches
        patches = events[0].delta
        assert len(patches) == 2
        assert any(patch["path"] == "/key1" and patch["value"] == "value1" for patch in patches)
        assert any(patch["path"] == "/key2" and patch["value"] == "value2" for patch in patches)

    @pytest.mark.asyncio
    async def test_translate_custom_event(self, translator, mock_adk_event):
        """Test custom event creation."""
        mock_adk_event.custom_data = {"custom_key": "custom_value"}

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1
        assert isinstance(events[0], CustomEvent)
        assert events[0].type == EventType.CUSTOM
        assert events[0].name == "adk_metadata"
        assert events[0].value == {"custom_key": "custom_value"}

    @pytest.mark.asyncio
    async def test_translate_exception_handling(self, translator, mock_adk_event):
        """Test exception handling during translation."""
        # Mock event that will cause an exception during iteration
        mock_adk_event.content = MagicMock()
        mock_adk_event.content.parts = MagicMock()
        # Make parts iteration raise an exception
        mock_adk_event.content.parts.__iter__ = MagicMock(side_effect=ValueError("Test exception"))

        with patch('ag_ui_adk.event_translator.logger') as mock_logger:
            events = []
            async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
                events.append(event)

            # Should log error but not yield error event
            mock_logger.error.assert_called_once()
            assert "Error translating ADK event" in str(mock_logger.error.call_args)
            assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_text_content_basic(self, translator, mock_adk_event_with_content):
        """Test basic text content translation."""
        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT , END
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert isinstance(events[2], TextMessageEndEvent)

        # Check content
        assert events[1].delta == "Test content"

        # Check message IDs are consistent
        message_id = events[0].message_id
        assert events[1].message_id == message_id

    @pytest.mark.asyncio
    async def test_translate_text_content_multiple_parts(self, translator, mock_adk_event):
        """Test text content with multiple parts."""
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = "First part"
        mock_part2 = MagicMock()
        mock_part2.text = "Second part"
        mock_content.parts = [mock_part1, mock_part2]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT , END
        assert isinstance(events[1], TextMessageContentEvent)
        assert events[1].delta == "First partSecond part"  # Joined without newlines

    @pytest.mark.asyncio
    async def test_translate_text_content_partial_streaming(self, translator, mock_adk_event_with_content):
        """Test partial streaming (no END event)."""
        mock_adk_event_with_content.partial = True
        mock_adk_event_with_content.turn_complete = False

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        # The translator keeps streaming open; forcing a close should yield END
        async for event in translator.force_close_streaming_message():
            events.append(event)

        assert len(events) == 3  # START, CONTENT, END (forced close)
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert isinstance(events[2], TextMessageEndEvent)

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_callable(self, translator, mock_adk_event_with_content):
        """Test final response detection with callable method."""
        mock_adk_event_with_content.is_final_response = MagicMock(return_value=True)

        # Set up streaming state
        translator._is_streaming = True
        translator._streaming_message_id = "test_message_id"

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1  # Only END event
        assert isinstance(events[0], TextMessageEndEvent)
        assert events[0].message_id == "test_message_id"

        # Should reset streaming state
        assert translator._is_streaming is False
        assert translator._streaming_message_id is None

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_property(self, translator, mock_adk_event_with_content):
        """Test final response detection with property."""
        mock_adk_event_with_content.is_final_response = True

        # Set up streaming state
        translator._is_streaming = True
        translator._streaming_message_id = "test_message_id"

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 1  # Only END event
        assert isinstance(events[0], TextMessageEndEvent)

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_no_streaming(self, translator, mock_adk_event_with_content):
        """Test final response when not streaming."""
        mock_adk_event_with_content.is_final_response = True

        # Not streaming
        translator._is_streaming = False

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0  # No events

    @pytest.mark.asyncio
    async def test_translate_text_content_final_response_from_agent_callback(self, translator, mock_adk_event_with_content):
        """Test final response when it was received from an agent callback function."""
        mock_adk_event_with_content.is_final_response = True
        mock_adk_event_with_content.usage_metadata = None

        # Not streaming
        translator._is_streaming = False

        events = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT , END
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert events[1].delta == mock_adk_event_with_content.content.parts[0].text
        assert isinstance(events[2], TextMessageEndEvent)

    @pytest.mark.asyncio
    async def test_translate_text_content_empty_text(self, translator, mock_adk_event):
        """Test text content with empty text."""
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = ""
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Empty text is filtered out by the translator, so no events are generated
        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_translate_text_content_none_text_parts(self, translator, mock_adk_event):
        """Test text content with None text parts."""
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = None
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_content.parts = [mock_part1, mock_part2]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 0  # No events for None text

    @pytest.mark.asyncio
    async def test_translate_text_content_mixed_text_parts(self, translator, mock_adk_event):
        """Test text content with mixed text and None parts."""
        mock_content = MagicMock()
        mock_part1 = MagicMock()
        mock_part1.text = "Valid text"
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_part3 = MagicMock()
        mock_part3.text = "More text"
        mock_content.parts = [mock_part1, mock_part2, mock_part3]
        mock_adk_event.content = mock_content

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        assert len(events) == 3  # START, CONTENT , END
        assert events[1].delta == "Valid textMore text"

    @pytest.mark.asyncio
    async def test_translate_function_calls_basic(self, translator, mock_adk_event):
        """Test basic function call translation."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.args = {"param1": "value1"}
        mock_function_call.id = "call_123"

        events = []
        async for event in translator._translate_function_calls(
             [mock_function_call]
        ):
            events.append(event)

        assert len(events) == 3  # START, ARGS, END
        assert isinstance(events[0], ToolCallStartEvent)
        assert isinstance(events[1], ToolCallArgsEvent)
        assert isinstance(events[2], ToolCallEndEvent)

        # Check details
        assert events[0].tool_call_id == "call_123"
        assert events[0].tool_call_name == "test_function"
        assert events[1].tool_call_id == "call_123"
        assert events[1].delta == '{"param1": "value1"}'
        assert events[2].tool_call_id == "call_123"

    @pytest.mark.asyncio
    async def test_translate_function_calls_no_id(self, translator, mock_adk_event):
        """Test function call translation without ID."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.args = {"param1": "value1"}
        # No id attribute
        delattr(mock_function_call, 'id')

        with patch('uuid.uuid4') as mock_uuid:
            mock_uuid.return_value = "generated_id"

            events = []
            async for event in translator._translate_function_calls(
                 [mock_function_call]
            ):
                events.append(event)

        assert len(events) == 3
        assert events[0].tool_call_id == "generated_id"
        assert events[1].tool_call_id == "generated_id"
        assert events[2].tool_call_id == "generated_id"

    @pytest.mark.asyncio
    async def test_translate_function_calls_no_args(self, translator, mock_adk_event):
        """Test function call translation without args."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.id = "call_123"
        # No args attribute
        delattr(mock_function_call, 'args')

        events = []
        async for event in translator._translate_function_calls(
            [mock_function_call]
        ):
            events.append(event)

        assert len(events) == 2  # START, END (no ARGS)
        assert isinstance(events[0], ToolCallStartEvent)
        assert isinstance(events[1], ToolCallEndEvent)

    @pytest.mark.asyncio
    async def test_translate_function_calls_string_args(self, translator, mock_adk_event):
        """Test function call translation with string args."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.args = "string_args"
        mock_function_call.id = "call_123"

        events = []
        async for event in translator._translate_function_calls(
             [mock_function_call]
        ):
            events.append(event)

        assert len(events) == 3
        assert events[1].delta == "string_args"

    @pytest.mark.asyncio
    async def test_translate_function_calls_multiple(self, translator, mock_adk_event):
        """Test multiple function calls translation."""
        mock_function_call1 = MagicMock()
        mock_function_call1.name = "function1"
        mock_function_call1.args = {"param1": "value1"}
        mock_function_call1.id = "call_1"

        mock_function_call2 = MagicMock()
        mock_function_call2.name = "function2"
        mock_function_call2.args = {"param2": "value2"}
        mock_function_call2.id = "call_2"

        events = []
        async for event in translator._translate_function_calls(
             [mock_function_call1, mock_function_call2]
        ):
            events.append(event)

        assert len(events) == 6  # 3 events per function call

        # Check first function call
        assert events[0].tool_call_id == "call_1"
        assert events[0].tool_call_name == "function1"
        assert events[1].tool_call_id == "call_1"
        assert events[2].tool_call_id == "call_1"

        # Check second function call
        assert events[3].tool_call_id == "call_2"
        assert events[3].tool_call_name == "function2"
        assert events[4].tool_call_id == "call_2"
        assert events[5].tool_call_id == "call_2"

    def test_create_state_delta_event_basic(self, translator):
        """Test basic state delta event creation."""
        state_delta = {"key1": "value1", "key2": "value2"}

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert event.type == EventType.STATE_DELTA
        assert len(event.delta) == 2

        # Check patches
        patches = event.delta
        assert any(patch["op"] == "add" and patch["path"] == "/key1" and patch["value"] == "value1" for patch in patches)
        assert any(patch["op"] == "add" and patch["path"] == "/key2" and patch["value"] == "value2" for patch in patches)

    def test_create_state_delta_event_empty(self, translator):
        """Test state delta event creation with empty delta."""
        event = translator._create_state_delta_event({}, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert event.delta == []

    def test_create_state_delta_event_nested_objects(self, translator):
        """Test state delta event creation with nested objects."""
        state_delta = {
            "user": {"name": "John", "age": 30},
            "settings": {"theme": "dark", "notifications": True}
        }

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert len(event.delta) == 2

        # Check patches for nested objects
        patches = event.delta
        assert any(patch["op"] == "add" and patch["path"] == "/user" and patch["value"] == {"name": "John", "age": 30} for patch in patches)
        assert any(patch["op"] == "add" and patch["path"] == "/settings" and patch["value"] == {"theme": "dark", "notifications": True} for patch in patches)

    def test_create_state_delta_event_array_values(self, translator):
        """Test state delta event creation with array values."""
        state_delta = {
            "items": ["item1", "item2", "item3"],
            "numbers": [1, 2, 3, 4, 5]
        }

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert len(event.delta) == 2

        # Check patches for arrays
        patches = event.delta
        assert any(patch["op"] == "add" and patch["path"] == "/items" and patch["value"] == ["item1", "item2", "item3"] for patch in patches)
        assert any(patch["op"] == "add" and patch["path"] == "/numbers" and patch["value"] == [1, 2, 3, 4, 5] for patch in patches)

    def test_create_state_delta_event_mixed_types(self, translator):
        """Test state delta event creation with mixed value types."""
        state_delta = {
            "string_val": "text",
            "number_val": 42,
            "boolean_val": True,
            "null_val": None,
            "object_val": {"nested": "value"},
            "array_val": [1, "mixed", {"nested": True}]
        }

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert len(event.delta) == 6

        # Check all patches use "add" operation
        patches = event.delta
        for patch in patches:
            assert patch["op"] == "add"
            assert patch["path"].startswith("/")

        # Verify specific values
        patch_dict = {patch["path"]: patch["value"] for patch in patches}
        assert patch_dict["/string_val"] == "text"
        assert patch_dict["/number_val"] == 42
        assert patch_dict["/boolean_val"] is True
        assert patch_dict["/null_val"] is None
        assert patch_dict["/object_val"] == {"nested": "value"}
        assert patch_dict["/array_val"] == [1, "mixed", {"nested": True}]

    def test_create_state_delta_event_special_characters_in_keys(self, translator):
        """Test state delta event creation with special characters in keys."""
        state_delta = {
            "key-with-dashes": "value1",
            "key_with_underscores": "value2",
            "key.with.dots": "value3",
            "key with spaces": "value4"
        }

        event = translator._create_state_delta_event(state_delta, "thread_1", "run_1")

        assert isinstance(event, StateDeltaEvent)
        assert len(event.delta) == 4

        # Check that all keys are properly escaped in paths
        patches = event.delta
        paths = [patch["path"] for patch in patches]
        assert "/key-with-dashes" in paths
        assert "/key_with_underscores" in paths
        assert "/key.with.dots" in paths
        assert "/key with spaces" in paths

    @pytest.mark.asyncio
    async def test_force_close_streaming_message_with_open_stream(self, translator):
        """Test force closing an open streaming message."""
        translator._is_streaming = True
        translator._streaming_message_id = "test_message_id"

        with patch('ag_ui_adk.event_translator.logger') as mock_logger:
            events = []
            async for event in translator.force_close_streaming_message():
                events.append(event)

        assert len(events) == 1
        assert isinstance(events[0], TextMessageEndEvent)
        assert events[0].message_id == "test_message_id"

        # Should reset streaming state
        assert translator._is_streaming is False
        assert translator._streaming_message_id is None

        # Should log warning
        mock_logger.warning.assert_called_once()
        assert "Force-closing unterminated streaming message" in str(mock_logger.warning.call_args)

    @pytest.mark.asyncio
    async def test_force_close_streaming_message_no_open_stream(self, translator):
        """Test force closing when no stream is open."""
        translator._is_streaming = False
        translator._streaming_message_id = None

        events = []
        async for event in translator.force_close_streaming_message():
            events.append(event)

        assert len(events) == 0

    def test_reset_translator_state(self, translator):
        """Test resetting translator state."""
        # Set up some state
        translator._is_streaming = True
        translator._streaming_message_id = "test_id"
        translator._active_tool_calls = {"call_1": "call_1", "call_2": "call_2"}

        translator.reset()

        # Should reset all state
        assert translator._is_streaming is False
        assert translator._streaming_message_id is None
        assert translator._active_tool_calls == {}

    @pytest.mark.asyncio
    async def test_streaming_state_management(self, translator, mock_adk_event_with_content):
        """Test streaming state management across multiple events."""
        # First event should start streaming
        events1 = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events1.append(event)

        assert len(events1) == 3  # START, CONTENT, END
        message_id = events1[0].message_id

        # streaming is stoped after TextMessageEndEvent
        assert translator._is_streaming is False
        # since the streaming is stopped
        assert translator._streaming_message_id == None

        # Second event should continue streaming (same message ID)
        events2 = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events2.append(event)

        assert len(events2) == 3  # New Streaming (START , CONTENT ,END)
        assert events2[0].message_id != message_id  # Same message ID

    @pytest.mark.asyncio
    async def test_complex_event_with_multiple_features(self, translator, mock_adk_event):
        """Test complex event with text, function calls, state delta, and custom data."""
        # Set up complex event
        mock_content = MagicMock()
        mock_part = MagicMock()
        mock_part.text = "Complex event text"
        mock_content.parts = [mock_part]
        mock_adk_event.content = mock_content

        # Add state delta
        mock_actions = MagicMock()
        mock_actions.state_delta = {"state_key": "state_value"}
        mock_adk_event.actions = mock_actions

        # Add custom data
        mock_adk_event.custom_data = {"custom_key": "custom_value"}

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should have text events, state delta, and custom event
        assert len(events) == 5  # START, CONTENT, STATE_DELTA, CUSTOM , END

        # Check event types
        event_types = [type(event) for event in events]
        assert TextMessageStartEvent in event_types
        assert TextMessageContentEvent in event_types
        assert StateDeltaEvent in event_types
        assert CustomEvent in event_types
        assert TextMessageEndEvent in event_types

    @pytest.mark.asyncio
    async def test_event_logging_coverage(self, translator, mock_adk_event_with_content):
        """Test comprehensive event logging."""
        with patch('ag_ui_adk.event_translator.logger') as mock_logger:
            events = []
            async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
                events.append(event)

            # Should log ADK event processing (now in debug logs)
            mock_logger.debug.assert_called()
            debug_calls = [str(call) for call in mock_logger.debug.call_args_list]
            assert any("ADK Event:" in call for call in debug_calls)

            # Text event logging remains in info
            mock_logger.info.assert_called()
            info_calls = [str(call) for call in mock_logger.info.call_args_list]
            assert any("Text event -" in call for call in info_calls)
            assert any("TEXT_MESSAGE_START:" in call for call in info_calls)
            assert any("TEXT_MESSAGE_CONTENT:" in call for call in info_calls)
            # No TEXT_MESSAGE_END unless is_final_response=True

    @pytest.mark.asyncio
    async def test_attribute_access_patterns(self, translator, mock_adk_event):
        """Test different attribute access patterns for ADK events."""
        # Test event with various attribute patterns
        mock_adk_event.partial = None  # Test None handling
        mock_adk_event.turn_complete = None

        # Remove is_final_response to test missing attribute
        delattr(mock_adk_event, 'is_final_response')

        events = []
        async for event in translator.translate(mock_adk_event, "thread_1", "run_1"):
            events.append(event)

        # Should handle missing/None attributes gracefully
        assert len(events) == 0  # No content to process

    @pytest.mark.asyncio
    async def test_tool_call_tracking_cleanup(self, translator, mock_adk_event):
        """Test that tool call tracking is properly cleaned up."""
        mock_function_call = MagicMock()
        mock_function_call.name = "test_function"
        mock_function_call.args = {"param": "value"}
        mock_function_call.id = "call_123"

        # Before translation
        assert len(translator._active_tool_calls) == 0

        events = []
        async for event in translator._translate_function_calls(
             [mock_function_call]
        ):
            events.append(event)

        # After translation, should be cleaned up
        assert len(translator._active_tool_calls) == 0

    @pytest.mark.asyncio
    async def test_partial_streaming_continuation(self, translator, mock_adk_event_with_content):
        """Test continuation of partial streaming."""
        # First partial event
        mock_adk_event_with_content.partial = True
        mock_adk_event_with_content.turn_complete = False

        events1 = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events1.append(event)

        assert len(events1) == 2  # START, CONTENT (stream remains open)
        assert translator._is_streaming is True
        message_id = events1[0].message_id

        # Second partial event (should continue streaming)
        mock_adk_event_with_content.partial = True
        mock_adk_event_with_content.turn_complete = False

        events2 = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events2.append(event)

        assert len(events2) == 1  # Additional CONTENT chunk
        assert isinstance(events2[0], TextMessageContentEvent)
        assert events2[0].message_id == message_id  # Same stream continues
        assert translator._is_streaming is True
        assert translator._streaming_message_id == message_id

        # Final event (should end streaming - requires is_final_response=True)
        mock_adk_event_with_content.partial = False
        mock_adk_event_with_content.turn_complete = True
        mock_adk_event_with_content.is_final_response = True

        events3 = []
        async for event in translator.translate(mock_adk_event_with_content, "thread_1", "run_1"):
            events3.append(event)

        assert len(events3) == 1  # Final END to close the stream
        assert isinstance(events3[0], TextMessageEndEvent)
        assert events3[0].message_id == message_id

        # Should reset streaming state
        assert translator._is_streaming is False
        assert translator._streaming_message_id is None
