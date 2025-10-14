#!/usr/bin/env python
"""Tests for utility functions in converters.py."""

import pytest
import json
from unittest.mock import MagicMock, patch, PropertyMock

from ag_ui.core import UserMessage, AssistantMessage, SystemMessage, ToolMessage, ToolCall, FunctionCall
from google.adk.events import Event as ADKEvent
from google.genai import types

from ag_ui_adk.utils.converters import (
    convert_ag_ui_messages_to_adk,
    convert_adk_event_to_ag_ui_message,
    convert_state_to_json_patch,
    convert_json_patch_to_state,
    extract_text_from_content,
    create_error_message
)


class TestConvertAGUIMessagesToADK:
    """Tests for convert_ag_ui_messages_to_adk function."""

    def test_convert_user_message(self):
        """Test converting a UserMessage to ADK event."""
        user_msg = UserMessage(
            id="user_1",
            role="user",
            content="Hello, how are you?"
        )

        adk_events = convert_ag_ui_messages_to_adk([user_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "user_1"
        assert event.author == "user"
        assert event.content.role == "user"
        assert len(event.content.parts) == 1
        assert event.content.parts[0].text == "Hello, how are you?"

    def test_convert_system_message(self):
        """Test converting a SystemMessage to ADK event."""
        system_msg = SystemMessage(
            id="system_1",
            role="system",
            content="You are a helpful assistant."
        )

        adk_events = convert_ag_ui_messages_to_adk([system_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "system_1"
        assert event.author == "system"
        assert event.content.role == "system"
        assert event.content.parts[0].text == "You are a helpful assistant."

    def test_convert_assistant_message_with_text(self):
        """Test converting an AssistantMessage with text content."""
        assistant_msg = AssistantMessage(
            id="assistant_1",
            role="assistant",
            content="I'm doing well, thank you!"
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "assistant_1"
        assert event.author == "assistant"
        assert event.content.role == "model"  # ADK uses "model" for assistant
        assert event.content.parts[0].text == "I'm doing well, thank you!"

    def test_convert_assistant_message_with_tool_calls(self):
        """Test converting an AssistantMessage with tool calls."""
        tool_call = ToolCall(
            id="call_123",
            type="function",
            function=FunctionCall(
                name="get_weather",
                arguments='{"location": "New York"}'
            )
        )

        assistant_msg = AssistantMessage(
            id="assistant_2",
            role="assistant",
            content="Let me check the weather for you.",
            tool_calls=[tool_call]
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.content.role == "model"
        assert len(event.content.parts) == 2  # Text + function call

        # Check text part
        text_part = event.content.parts[0]
        assert text_part.text == "Let me check the weather for you."

        # Check function call part
        func_part = event.content.parts[1]
        assert func_part.function_call.name == "get_weather"
        assert func_part.function_call.args == {"location": "New York"}
        assert func_part.function_call.id == "call_123"

    def test_convert_assistant_message_with_dict_tool_args(self):
        """Test converting tool calls with dict arguments (not JSON string)."""
        tool_call = ToolCall(
            id="call_456",
            type="function",
            function=FunctionCall(
                name="calculate",
                arguments='{"expression": "2 + 2"}'
            )
        )

        assistant_msg = AssistantMessage(
            id="assistant_3",
            role="assistant",
            tool_calls=[tool_call]
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        event = adk_events[0]
        func_part = event.content.parts[0]
        assert func_part.function_call.args == {"expression": "2 + 2"}

    def test_convert_tool_message(self):
        """Test converting a ToolMessage to ADK event."""
        tool_msg = ToolMessage(
            id="tool_1",
            role="tool",
            content='{"temperature": 72, "condition": "sunny"}',
            tool_call_id="call_123"
        )

        adk_events = convert_ag_ui_messages_to_adk([tool_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.id == "tool_1"
        assert event.author == "tool"
        assert event.content.role == "function"

        func_response = event.content.parts[0].function_response
        assert func_response.name == "call_123"
        assert func_response.id == "call_123"
        assert func_response.response == {"result": '{"temperature": 72, "condition": "sunny"}'}

    def test_convert_tool_message_with_dict_content(self):
        """Test converting a ToolMessage with dict content (not JSON string)."""
        tool_msg = ToolMessage(
            id="tool_2",
            role="tool",
            content='{"result": "success", "value": 42}',  # Must be JSON string
            tool_call_id="call_456"
        )

        adk_events = convert_ag_ui_messages_to_adk([tool_msg])

        event = adk_events[0]
        func_response = event.content.parts[0].function_response
        assert func_response.response == {"result": '{"result": "success", "value": 42}'}

    def test_convert_empty_message_list(self):
        """Test converting an empty message list."""
        adk_events = convert_ag_ui_messages_to_adk([])
        assert adk_events == []

    def test_convert_message_without_content(self):
        """Test converting a message without content."""
        user_msg = UserMessage(id="user_2", role="user", content="")

        adk_events = convert_ag_ui_messages_to_adk([user_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        # Empty content creates content=None because empty string is falsy
        assert event.content is None

    def test_convert_assistant_message_without_content_or_tools(self):
        """Test converting an AssistantMessage without content or tool calls."""
        assistant_msg = AssistantMessage(
            id="assistant_4",
            role="assistant",
            content=None,
            tool_calls=None
        )

        adk_events = convert_ag_ui_messages_to_adk([assistant_msg])

        assert len(adk_events) == 1
        event = adk_events[0]
        assert event.content is None

    def test_convert_multiple_messages(self):
        """Test converting multiple messages."""
        messages = [
            UserMessage(id="1", role="user", content="Hello"),
            AssistantMessage(id="2", role="assistant", content="Hi there!"),
            UserMessage(id="3", role="user", content="How are you?")
        ]

        adk_events = convert_ag_ui_messages_to_adk(messages)

        assert len(adk_events) == 3
        assert adk_events[0].id == "1"
        assert adk_events[1].id == "2"
        assert adk_events[2].id == "3"

    @patch('ag_ui_adk.utils.converters.logger')
    def test_convert_with_exception_handling(self, mock_logger):
        """Test that exceptions during conversion are logged and skipped."""
        # Create a message that will cause an exception
        bad_msg = UserMessage(id="bad", role="user", content="test")

        # Mock the ADKEvent constructor to raise an exception
        with patch('ag_ui_adk.utils.converters.ADKEvent') as mock_adk_event:
            mock_adk_event.side_effect = ValueError("Test exception")

            adk_events = convert_ag_ui_messages_to_adk([bad_msg])

            # Should return empty list and log error
            assert adk_events == []
            mock_logger.error.assert_called_once()
            assert "Error converting message bad" in str(mock_logger.error.call_args)


class TestConvertADKEventToAGUIMessage:
    """Tests for convert_adk_event_to_ag_ui_message function."""

    def test_convert_user_event(self):
        """Test converting ADK user event to AG-UI message."""
        mock_event = MagicMock()
        mock_event.id = "user_1"
        mock_event.author = "user"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = "Hello, assistant!"
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert isinstance(result, UserMessage)
        assert result.id == "user_1"
        assert result.role == "user"
        assert result.content == "Hello, assistant!"

    def test_convert_user_event_multiple_text_parts(self):
        """Test converting user event with multiple text parts."""
        mock_event = MagicMock()
        mock_event.id = "user_2"
        mock_event.author = "user"
        mock_event.content = MagicMock()

        mock_part1 = MagicMock()
        mock_part1.text = "First part"
        mock_part2 = MagicMock()
        mock_part2.text = "Second part"
        mock_event.content.parts = [mock_part1, mock_part2]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result.content == "First part\nSecond part"

    def test_convert_assistant_event_with_text(self):
        """Test converting ADK assistant event with text content."""
        mock_event = MagicMock()
        mock_event.id = "assistant_1"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = "I can help you with that."
        mock_part.function_call = None
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert isinstance(result, AssistantMessage)
        assert result.id == "assistant_1"
        assert result.role == "assistant"
        assert result.content == "I can help you with that."
        assert result.tool_calls is None

    def test_convert_assistant_event_with_function_call(self):
        """Test converting assistant event with function call."""
        mock_event = MagicMock()
        mock_event.id = "assistant_2"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = None
        mock_part.function_call = MagicMock()
        mock_part.function_call.name = "get_weather"
        mock_part.function_call.args = {"location": "Boston"}
        mock_part.function_call.id = "call_123"
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert isinstance(result, AssistantMessage)
        assert result.content is None
        assert len(result.tool_calls) == 1

        tool_call = result.tool_calls[0]
        assert tool_call.id == "call_123"
        assert tool_call.type == "function"
        assert tool_call.function.name == "get_weather"
        assert tool_call.function.arguments == '{"location": "Boston"}'

    def test_convert_assistant_event_with_text_and_function_call(self):
        """Test converting assistant event with both text and function call."""
        mock_event = MagicMock()
        mock_event.id = "assistant_3"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_text_part = MagicMock()
        mock_text_part.text = "Let me check the weather."
        mock_text_part.function_call = None

        mock_func_part = MagicMock()
        mock_func_part.text = None
        mock_func_part.function_call = MagicMock()
        mock_func_part.function_call.name = "get_weather"
        mock_func_part.function_call.args = {"location": "Seattle"}
        mock_func_part.function_call.id = "call_456"

        mock_event.content.parts = [mock_text_part, mock_func_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result.content == "Let me check the weather."
        assert len(result.tool_calls) == 1
        assert result.tool_calls[0].function.name == "get_weather"

    def test_convert_function_call_without_args(self):
        """Test converting function call without args."""
        mock_event = MagicMock()
        mock_event.id = "assistant_4"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = None
        mock_part.function_call = MagicMock()
        mock_part.function_call.name = "get_time"
        # No args attribute
        delattr(mock_part.function_call, 'args')
        mock_part.function_call.id = "call_789"

        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        tool_call = result.tool_calls[0]
        assert tool_call.function.arguments == "{}"

    def test_convert_function_call_without_id(self):
        """Test converting function call without id."""
        mock_event = MagicMock()
        mock_event.id = "assistant_5"
        mock_event.author = "model"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = None
        mock_part.function_call = MagicMock()
        mock_part.function_call.name = "get_time"
        mock_part.function_call.args = {}
        # No id attribute
        delattr(mock_part.function_call, 'id')

        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        tool_call = result.tool_calls[0]
        assert tool_call.id == "assistant_5"  # Falls back to event ID

    def test_convert_event_without_content(self):
        """Test converting event without content."""
        mock_event = MagicMock()
        mock_event.id = "empty_1"
        mock_event.author = "model"
        mock_event.content = None

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result is None

    def test_convert_event_without_parts(self):
        """Test converting event without parts."""
        mock_event = MagicMock()
        mock_event.id = "empty_2"
        mock_event.author = "model"
        mock_event.content = MagicMock()
        mock_event.content.parts = []

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result is None

    def test_convert_user_event_without_text(self):
        """Test converting user event without text content."""
        mock_event = MagicMock()
        mock_event.id = "user_3"
        mock_event.author = "user"
        mock_event.content = MagicMock()

        mock_part = MagicMock()
        mock_part.text = None
        mock_event.content.parts = [mock_part]

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result is None

    @patch('ag_ui_adk.utils.converters.logger')
    def test_convert_with_exception_handling(self, mock_logger):
        """Test that exceptions during conversion are logged and None returned."""
        mock_event = MagicMock()
        mock_event.id = "bad_event"
        mock_event.author = "user"
        mock_event.content = MagicMock()
        mock_event.content.parts = [MagicMock()]
        # Make parts[0].text raise an exception when accessed
        type(mock_event.content.parts[0]).text = PropertyMock(side_effect=ValueError("Test exception"))

        result = convert_adk_event_to_ag_ui_message(mock_event)

        assert result is None
        mock_logger.error.assert_called_once()
        assert "Error converting ADK event bad_event" in str(mock_logger.error.call_args)


class TestStateConversionFunctions:
    """Tests for state conversion functions."""

    def test_convert_state_to_json_patch_basic(self):
        """Test converting state delta to JSON patch operations."""
        state_delta = {
            "user_name": "John",
            "status": "active",
            "count": 42
        }

        patches = convert_state_to_json_patch(state_delta)

        assert len(patches) == 3

        # Check each patch
        user_patch = next(p for p in patches if p["path"] == "/user_name")
        assert user_patch["op"] == "replace"
        assert user_patch["value"] == "John"

        status_patch = next(p for p in patches if p["path"] == "/status")
        assert status_patch["op"] == "replace"
        assert status_patch["value"] == "active"

        count_patch = next(p for p in patches if p["path"] == "/count")
        assert count_patch["op"] == "replace"
        assert count_patch["value"] == 42

    def test_convert_state_to_json_patch_with_none_values(self):
        """Test converting state delta with None values (remove operations)."""
        state_delta = {
            "keep_this": "value",
            "remove_this": None,
            "also_remove": None
        }

        patches = convert_state_to_json_patch(state_delta)

        assert len(patches) == 3

        keep_patch = next(p for p in patches if p["path"] == "/keep_this")
        assert keep_patch["op"] == "replace"
        assert keep_patch["value"] == "value"

        remove_patch = next(p for p in patches if p["path"] == "/remove_this")
        assert remove_patch["op"] == "remove"
        assert "value" not in remove_patch

        also_remove_patch = next(p for p in patches if p["path"] == "/also_remove")
        assert also_remove_patch["op"] == "remove"

    def test_convert_state_to_json_patch_empty_dict(self):
        """Test converting empty state delta."""
        patches = convert_state_to_json_patch({})
        assert patches == []

    def test_convert_json_patch_to_state_basic(self):
        """Test converting JSON patch operations to state delta."""
        patches = [
            {"op": "replace", "path": "/user_name", "value": "Alice"},
            {"op": "add", "path": "/new_field", "value": "new_value"},
            {"op": "remove", "path": "/old_field"}
        ]

        state_delta = convert_json_patch_to_state(patches)

        assert len(state_delta) == 3
        assert state_delta["user_name"] == "Alice"
        assert state_delta["new_field"] == "new_value"
        assert state_delta["old_field"] is None

    def test_convert_json_patch_to_state_with_nested_paths(self):
        """Test converting patches with nested paths (only first level supported)."""
        patches = [
            {"op": "replace", "path": "/user/name", "value": "Bob"},
            {"op": "add", "path": "/config/theme", "value": "dark"}
        ]

        state_delta = convert_json_patch_to_state(patches)

        # Should extract the first path segment after the slash
        assert state_delta["user/name"] == "Bob"
        assert state_delta["config/theme"] == "dark"

    def test_convert_json_patch_to_state_with_unsupported_ops(self):
        """Test converting patches with unsupported operations."""
        patches = [
            {"op": "replace", "path": "/supported", "value": "yes"},
            {"op": "copy", "path": "/unsupported", "from": "/somewhere"},
            {"op": "move", "path": "/also_unsupported", "from": "/elsewhere"},
            {"op": "test", "path": "/test_op", "value": "test"}
        ]

        state_delta = convert_json_patch_to_state(patches)

        # Should only process the replace operation
        assert len(state_delta) == 1
        assert state_delta["supported"] == "yes"

    def test_convert_json_patch_to_state_empty_list(self):
        """Test converting empty patch list."""
        state_delta = convert_json_patch_to_state([])
        assert state_delta == {}

    def test_convert_json_patch_to_state_malformed_patches(self):
        """Test converting malformed patches."""
        patches = [
            {"op": "replace", "path": "/good", "value": "value"},
            {"op": "replace"},  # No path
            {"path": "/no_op", "value": "value"},  # No op
            {"op": "replace", "path": "", "value": "empty_path"}  # Empty path
        ]

        state_delta = convert_json_patch_to_state(patches)

        # Should only process the good patch
        assert len(state_delta) == 2
        assert state_delta["good"] == "value"
        assert state_delta[""] == "empty_path"  # Empty path becomes empty key

    def test_roundtrip_conversion(self):
        """Test that state -> patches -> state works correctly."""
        original_state = {
            "name": "Test",
            "active": True,
            "count": 100,
            "remove_me": None
        }

        patches = convert_state_to_json_patch(original_state)
        converted_state = convert_json_patch_to_state(patches)

        assert converted_state == original_state


class TestUtilityFunctions:
    """Tests for utility functions."""

    def test_extract_text_from_content_basic(self):
        """Test extracting text from ADK Content object."""
        mock_content = MagicMock()

        mock_part1 = MagicMock()
        mock_part1.text = "Hello"
        mock_part2 = MagicMock()
        mock_part2.text = "World"
        mock_content.parts = [mock_part1, mock_part2]

        result = extract_text_from_content(mock_content)

        assert result == "Hello\nWorld"

    def test_extract_text_from_content_with_none_text(self):
        """Test extracting text when some parts have None text."""
        mock_content = MagicMock()

        mock_part1 = MagicMock()
        mock_part1.text = "Hello"
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_part3 = MagicMock()
        mock_part3.text = "World"
        mock_content.parts = [mock_part1, mock_part2, mock_part3]

        result = extract_text_from_content(mock_content)

        assert result == "Hello\nWorld"

    def test_extract_text_from_content_no_text_parts(self):
        """Test extracting text when no parts have text."""
        mock_content = MagicMock()

        mock_part1 = MagicMock()
        mock_part1.text = None
        mock_part2 = MagicMock()
        mock_part2.text = None
        mock_content.parts = [mock_part1, mock_part2]

        result = extract_text_from_content(mock_content)

        assert result == ""

    def test_extract_text_from_content_no_parts(self):
        """Test extracting text when content has no parts."""
        mock_content = MagicMock()
        mock_content.parts = []

        result = extract_text_from_content(mock_content)

        assert result == ""

    def test_extract_text_from_content_none_content(self):
        """Test extracting text from None content."""
        result = extract_text_from_content(None)

        assert result == ""

    def test_extract_text_from_content_no_parts_attribute(self):
        """Test extracting text when content has no parts attribute."""
        mock_content = MagicMock()
        mock_content.parts = None

        result = extract_text_from_content(mock_content)

        assert result == ""

    def test_create_error_message_basic(self):
        """Test creating error message from exception."""
        error = ValueError("Something went wrong")

        result = create_error_message(error)

        assert result == "ValueError: Something went wrong"

    def test_create_error_message_with_context(self):
        """Test creating error message with context."""
        error = RuntimeError("Database connection failed")
        context = "During user authentication"

        result = create_error_message(error, context)

        assert result == "During user authentication: RuntimeError - Database connection failed"

    def test_create_error_message_empty_context(self):
        """Test creating error message with empty context."""
        error = TypeError("Invalid type")

        result = create_error_message(error, "")

        assert result == "TypeError: Invalid type"

    def test_create_error_message_custom_exception(self):
        """Test creating error message from custom exception."""
        class CustomError(Exception):
            pass

        error = CustomError("Custom error message")

        result = create_error_message(error)

        assert result == "CustomError: Custom error message"

    def test_create_error_message_exception_without_message(self):
        """Test creating error message from exception without message."""
        error = ValueError()

        result = create_error_message(error)

        assert result == "ValueError: "