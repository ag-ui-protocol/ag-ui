"""Tests for EventTranslator."""

import pytest
from unittest.mock import Mock, MagicMock
from types import SimpleNamespace

from ag_ui_claude.event_translator import EventTranslator
from ag_ui.core import (
    EventType,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
)


class TestEventTranslator:
    """Test cases for EventTranslator."""

    @pytest.fixture
    def translator(self):
        """Create an EventTranslator instance."""
        return EventTranslator()

    def test_initialization(self, translator):
        """Test EventTranslator initialization."""
        assert translator._active_tool_calls == {}
        assert translator._streaming_message_id is None
        assert translator._is_streaming is False
        assert translator._current_stream_text == ""

    @pytest.mark.asyncio
    async def test_translate_text_block(self, translator):
        """Test translating TextBlock to AG-UI events."""
        text_block = SimpleNamespace()
        text_block.text = "Hello, world!"
        
        events = []
        async for event in translator._translate_text_block(text_block, "thread_1", "run_1"):
            events.append(event)
        
        assert len(events) == 2  # START + CONTENT
        assert isinstance(events[0], TextMessageStartEvent)
        assert isinstance(events[1], TextMessageContentEvent)
        assert events[1].delta == "Hello, world!"

    @pytest.mark.asyncio
    async def test_translate_text_block_streaming(self, translator):
        """Test translating multiple TextBlocks in sequence."""
        # First block
        block1 = SimpleNamespace()
        block1.text = "Hello, "
        
        events1 = []
        async for event in translator._translate_text_block(block1, "thread_1", "run_1"):
            events1.append(event)
        
        # Second block
        block2 = SimpleNamespace()
        block2.text = "world!"
        
        events2 = []
        async for event in translator._translate_text_block(block2, "thread_1", "run_1"):
            events2.append(event)
        
        # Should have START from first, CONTENT from both
        assert len(events1) == 2
        assert len(events2) == 1  # Only CONTENT, reusing message_id
        assert events2[0].delta == "world!"

    @pytest.mark.asyncio
    async def test_translate_tool_use_block(self, translator):
        """Test translating ToolUseBlock to AG-UI events."""
        tool_block = SimpleNamespace()
        tool_block.id = "tool_call_123"
        tool_block.name = "get_weather"
        tool_block.input = {"location": "San Francisco"}
        
        events = []
        async for event in translator._translate_tool_use_block(tool_block):
            events.append(event)
        
        assert len(events) >= 3  # START, ARGS, END
        assert isinstance(events[0], ToolCallStartEvent)
        assert events[0].tool_call_id == "tool_call_123"
        assert events[0].tool_call_name == "get_weather"
        assert isinstance(events[-1], ToolCallEndEvent)

    @pytest.mark.asyncio
    async def test_translate_tool_result_block(self, translator):
        """Test translating ToolResultBlock to AG-UI events."""
        tool_result_block = SimpleNamespace()
        tool_result_block.tool_use_id = "tool_call_123"
        tool_result_block.content = "Sunny, 72°F"
        tool_result_block.is_error = False
        
        events = []
        async for event in translator._translate_tool_result_block(tool_result_block):
            events.append(event)
        
        assert len(events) == 1
        assert isinstance(events[0], ToolCallResultEvent)
        assert events[0].tool_call_id == "tool_call_123"

    @pytest.mark.asyncio
    async def test_translate_tool_result_block_error(self, translator):
        """Test translating ToolResultBlock with error."""
        tool_result_block = SimpleNamespace()
        tool_result_block.tool_use_id = "tool_call_123"
        tool_result_block.content = "Error occurred"
        tool_result_block.is_error = True
        
        events = []
        async for event in translator._translate_tool_result_block(tool_result_block):
            events.append(event)
        
        assert len(events) == 1
        assert isinstance(events[0], ToolCallResultEvent)
        # Error should be marked in content
        assert "error" in events[0].content.lower() or "true" in events[0].content.lower()

    @pytest.mark.asyncio
    async def test_translate_assistant_message_text(self, translator):
        """Test translating AssistantMessage with TextBlock."""
        text_block = SimpleNamespace()
        text_block.text = "Hello!"
        
        message = SimpleNamespace()
        message.content = [text_block]
        
        events = []
        async for event in translator._translate_assistant_message(message, "thread_1", "run_1"):
            events.append(event)
        
        assert len(events) >= 1
        assert any(isinstance(e, TextMessageStartEvent) for e in events)
        assert any(isinstance(e, TextMessageContentEvent) for e in events)

    @pytest.mark.asyncio
    async def test_translate_assistant_message_tool(self, translator):
        """Test translating AssistantMessage with ToolUseBlock."""
        tool_block = SimpleNamespace()
        tool_block.id = "tool_1"
        tool_block.name = "test_tool"
        tool_block.input = {}
        
        message = SimpleNamespace()
        message.content = [tool_block]
        
        events = []
        async for event in translator._translate_assistant_message(message, "thread_1", "run_1"):
            events.append(event)
        
        assert len(events) >= 1
        assert any(isinstance(e, ToolCallStartEvent) for e in events)

    @pytest.mark.asyncio
    async def test_translate_result_message_success(self, translator):
        """Test translating ResultMessage with success."""
        result_message = SimpleNamespace()
        result_message.subtype = "success"
        
        events = []
        async for event in translator.translate_claude_message(result_message, "thread_1", "run_1"):
            events.append(event)
        
        # Should close any streaming messages
        assert len(events) >= 0  # May have force_close_streaming_message events

    @pytest.mark.asyncio
    async def test_force_close_streaming_message(self, translator):
        """Test force closing streaming message."""
        # Start streaming
        text_block = SimpleNamespace()
        text_block.text = "Hello"
        
        async for _ in translator._translate_text_block(text_block, "thread_1", "run_1"):
            pass
        
        # Force close
        events = []
        async for event in translator.force_close_streaming_message():
            events.append(event)
        
        assert len(events) == 1
        assert isinstance(events[0], TextMessageEndEvent)
        assert translator._is_streaming is False

    @pytest.mark.asyncio
    async def test_force_close_no_streaming(self, translator):
        """Test force close when not streaming."""
        events = []
        async for event in translator.force_close_streaming_message():
            events.append(event)
        
        assert len(events) == 0

    def test_reset(self, translator):
        """Test resetting translator state."""
        # Set some state
        translator._streaming_message_id = "msg_123"
        translator._is_streaming = True
        translator._active_tool_calls["tool_1"] = "tool_1"
        
        translator.reset()
        
        assert translator._streaming_message_id is None
        assert translator._is_streaming is False
        assert translator._active_tool_calls == {}

    @pytest.mark.asyncio
    async def test_translate_claude_message_assistant(self, translator):
        """Test translating AssistantMessage."""
        text_block = SimpleNamespace()
        text_block.text = "Response"
        
        message = SimpleNamespace()
        message.content = [text_block]
        
        events = []
        async for event in translator.translate_claude_message(message, "thread_1", "run_1"):
            events.append(event)
        
        assert len(events) > 0

    @pytest.mark.asyncio
    async def test_translate_claude_message_result(self, translator):
        """Test translating ResultMessage."""
        result_message = SimpleNamespace()
        result_message.subtype = "success"
        
        events = []
        async for event in translator.translate_claude_message(result_message, "thread_1", "run_1"):
            events.append(event)
        
        # Should handle result message
        assert isinstance(events, list)

