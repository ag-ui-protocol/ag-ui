"""Tests for AG-UI <-> LangChain message conversion functions."""
import json
import pytest

from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage

from ag_ui.core import (
    UserMessage as AGUIUserMessage,
    AssistantMessage as AGUIAssistantMessage,
    SystemMessage as AGUISystemMessage,
    ToolMessage as AGUIToolMessage,
    ToolCall as AGUIToolCall,
    FunctionCall as AGUIFunctionCall,
    TextInputContent,
    BinaryInputContent,
)
from ag_ui_langgraph.utils import (
    agui_messages_to_langchain,
    langchain_messages_to_agui,
    normalize_tool_content,
)


class TestAguiMessagesToLangchain:
    """Tests for agui_messages_to_langchain()."""

    def test_human_message(self):
        msg = AGUIUserMessage(id="h1", role="user", content="Hello")
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        assert isinstance(result[0], HumanMessage)
        assert result[0].content == "Hello"
        assert result[0].id == "h1"

    def test_assistant_message_plain(self):
        msg = AGUIAssistantMessage(id="a1", role="assistant", content="Hi there")
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        assert isinstance(result[0], AIMessage)
        assert result[0].content == "Hi there"
        assert result[0].id == "a1"

    def test_assistant_message_with_tool_calls(self):
        msg = AGUIAssistantMessage(
            id="a2",
            role="assistant",
            content="",
            tool_calls=[
                AGUIToolCall(
                    id="tc1",
                    type="function",
                    function=AGUIFunctionCall(
                        name="search",
                        arguments='{"query": "weather"}',
                    ),
                )
            ],
        )
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        ai = result[0]
        assert isinstance(ai, AIMessage)
        assert len(ai.tool_calls) == 1
        assert ai.tool_calls[0]["id"] == "tc1"
        assert ai.tool_calls[0]["name"] == "search"
        assert ai.tool_calls[0]["args"] == {"query": "weather"}

    def test_system_message(self):
        msg = AGUISystemMessage(id="s1", role="system", content="You are helpful")
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        assert isinstance(result[0], SystemMessage)
        assert result[0].content == "You are helpful"

    def test_tool_message(self):
        msg = AGUIToolMessage(id="t1", role="tool", content="42", tool_call_id="tc1")
        result = agui_messages_to_langchain([msg])
        assert len(result) == 1
        assert isinstance(result[0], ToolMessage)
        assert result[0].content == "42"
        assert result[0].tool_call_id == "tc1"

    def test_multimodal_with_url(self):
        msg = AGUIUserMessage(
            id="m1",
            role="user",
            content=[
                TextInputContent(type="text", text="What is this?"),
                BinaryInputContent(type="binary", mime_type="image/png", url="https://example.com/img.png"),
            ],
        )
        result = agui_messages_to_langchain([msg])
        assert isinstance(result[0], HumanMessage)
        content = result[0].content
        assert isinstance(content, list)
        assert content[0] == {"type": "text", "text": "What is this?"}
        assert content[1]["type"] == "image_url"
        assert content[1]["image_url"]["url"] == "https://example.com/img.png"

    def test_multimodal_with_base64(self):
        msg = AGUIUserMessage(
            id="m2",
            role="user",
            content=[
                BinaryInputContent(type="binary", mime_type="image/jpeg", data="abc123base64"),
            ],
        )
        result = agui_messages_to_langchain([msg])
        content = result[0].content
        assert isinstance(content, list)
        assert content[0]["image_url"]["url"] == "data:image/jpeg;base64,abc123base64"

    def test_unsupported_role_raises(self):
        # Create a message-like object with an unsupported role
        class FakeMsg:
            id = "x"
            role = "unknown"
            content = "test"
            name = None
        with pytest.raises(ValueError, match="Unsupported message role"):
            agui_messages_to_langchain([FakeMsg()])

    def test_multiple_messages_ordering(self):
        msgs = [
            AGUIUserMessage(id="1", role="user", content="Q"),
            AGUIAssistantMessage(id="2", role="assistant", content="A"),
            AGUIUserMessage(id="3", role="user", content="Q2"),
        ]
        result = agui_messages_to_langchain(msgs)
        assert len(result) == 3
        assert isinstance(result[0], HumanMessage)
        assert isinstance(result[1], AIMessage)
        assert isinstance(result[2], HumanMessage)


class TestLangchainMessagesToAgui:
    """Tests for langchain_messages_to_agui()."""

    def test_human_message(self):
        msg = HumanMessage(id="h1", content="Hello")
        result = langchain_messages_to_agui([msg])
        assert len(result) == 1
        assert result[0].role == "user"
        assert result[0].content == "Hello"
        assert result[0].id == "h1"

    def test_ai_message_plain(self):
        msg = AIMessage(id="a1", content="Response")
        result = langchain_messages_to_agui([msg])
        assert result[0].role == "assistant"
        assert result[0].content == "Response"

    def test_ai_message_with_tool_calls(self):
        msg = AIMessage(
            id="a2",
            content="",
            tool_calls=[
                {"id": "tc1", "name": "search", "args": {"q": "hello"}},
            ],
        )
        result = langchain_messages_to_agui([msg])
        assistant = result[0]
        assert assistant.role == "assistant"
        assert len(assistant.tool_calls) == 1
        tc = assistant.tool_calls[0]
        assert tc.id == "tc1"
        assert tc.function.name == "search"
        assert json.loads(tc.function.arguments) == {"q": "hello"}

    def test_system_message(self):
        msg = SystemMessage(id="s1", content="System prompt")
        result = langchain_messages_to_agui([msg])
        assert result[0].role == "system"
        assert result[0].content == "System prompt"

    def test_tool_message(self):
        msg = ToolMessage(id="t1", content="result", tool_call_id="tc1")
        result = langchain_messages_to_agui([msg])
        assert result[0].role == "tool"
        assert result[0].content == "result"
        assert result[0].tool_call_id == "tc1"

    def test_multimodal_human_message(self):
        msg = HumanMessage(
            id="m1",
            content=[
                {"type": "text", "text": "Look at this"},
                {"type": "image_url", "image_url": {"url": "https://example.com/img.png"}},
            ],
        )
        result = langchain_messages_to_agui([msg])
        content = result[0].content
        assert isinstance(content, list)
        assert content[0].type == "text"
        assert content[0].text == "Look at this"
        assert content[1].type == "image"
        assert content[1].source.type == "url"
        assert content[1].source.value == "https://example.com/img.png"

    def test_multimodal_data_url_parsed(self):
        msg = HumanMessage(
            id="m2",
            content=[
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,abc123"}},
            ],
        )
        result = langchain_messages_to_agui([msg])
        content = result[0].content
        assert isinstance(content, list)
        assert content[0].type == "image"
        assert content[0].source.type == "data"
        assert content[0].source.mime_type == "image/jpeg"
        assert content[0].source.value == "abc123"


class TestRoundTrip:
    """Tests that messages survive conversion in both directions."""

    def test_human_round_trip(self):
        original = AGUIUserMessage(id="rt1", role="user", content="Test message")
        lc = agui_messages_to_langchain([original])
        back = langchain_messages_to_agui(lc)
        assert back[0].role == "user"
        assert back[0].content == "Test message"
        assert back[0].id == "rt1"

    def test_assistant_with_tools_round_trip(self):
        original = AGUIAssistantMessage(
            id="rt2",
            role="assistant",
            content="",
            tool_calls=[
                AGUIToolCall(
                    id="tc1",
                    type="function",
                    function=AGUIFunctionCall(name="calc", arguments='{"x": 1}'),
                )
            ],
        )
        lc = agui_messages_to_langchain([original])
        back = langchain_messages_to_agui(lc)
        assert back[0].role == "assistant"
        assert len(back[0].tool_calls) == 1
        assert back[0].tool_calls[0].function.name == "calc"
        assert json.loads(back[0].tool_calls[0].function.arguments) == {"x": 1}

    def test_tool_message_round_trip(self):
        original = AGUIToolMessage(id="rt3", role="tool", content="done", tool_call_id="tc1")
        lc = agui_messages_to_langchain([original])
        back = langchain_messages_to_agui(lc)
        assert back[0].role == "tool"
        assert back[0].content == "done"
        assert back[0].tool_call_id == "tc1"


class TestNormalizeToolContent:
    """Tests for normalize_tool_content()."""

    def test_string_passthrough(self):
        assert normalize_tool_content("hello") == "hello"

    def test_list_of_strings(self):
        assert normalize_tool_content(["a", "b"]) == "ab"

    def test_list_of_text_blocks(self):
        blocks = [{"type": "text", "text": "hello "}, {"type": "text", "text": "world"}]
        assert normalize_tool_content(blocks) == "hello world"

    def test_dict_serialized(self):
        result = normalize_tool_content({"key": "value"})
        assert json.loads(result) == {"key": "value"}

    def test_mixed_list(self):
        blocks = ["prefix", {"type": "text", "text": "content"}, {"type": "other", "data": 1}]
        result = normalize_tool_content(blocks)
        assert "prefix" in result
        assert "content" in result

    def test_empty_string(self):
        assert normalize_tool_content("") == ""

    def test_none_serialized(self):
        result = normalize_tool_content(None)
        assert result == "null"


class TestEdgeCases:
    """Edge cases for conversion functions."""

    def test_empty_message_list(self):
        """Empty input → empty output, no exception."""
        assert agui_messages_to_langchain([]) == []
        assert langchain_messages_to_agui([]) == []

    def test_ai_message_with_list_content(self):
        """AI message with list content (text blocks) → text is extracted."""
        msg = AIMessage(id="a1", content=[{"type": "text", "text": "extracted"}])
        result = langchain_messages_to_agui([msg])
        assert result[0].content == "extracted"

    def test_ai_message_with_empty_content_string(self):
        """AI message with empty string content → empty string preserved."""
        msg = AIMessage(id="a2", content="")
        result = langchain_messages_to_agui([msg])
        assert result[0].content == ""

    def test_tool_message_with_list_content(self):
        """Tool message with list content → normalize_tool_content applied."""
        msg = ToolMessage(id="t1", content=[{"type": "text", "text": "ok"}], tool_call_id="tc1")
        result = langchain_messages_to_agui([msg])
        assert result[0].content == "ok"

    def test_human_message_name_preserved(self):
        """HumanMessage name field should be preserved in the AG-UI message."""
        msg = HumanMessage(id="h1", content="hi", name="alice")
        result = langchain_messages_to_agui([msg])
        assert result[0].name == "alice"

    def test_agui_assistant_message_no_tool_calls_converts(self):
        """AG-UI assistant message without tool_calls should produce an AIMessage with empty tool_calls."""
        msg = AGUIAssistantMessage(id="a3", role="assistant", content="plain text")
        result = agui_messages_to_langchain([msg])
        assert isinstance(result[0], AIMessage)
        assert result[0].tool_calls == []
