"""Tests for RequestBuilder provider-specific code paths."""

import pytest
from unittest.mock import MagicMock

from ag_ui_openresponses.providers.base import get_provider
from ag_ui_openresponses.request.request_builder import RequestBuilder
from ag_ui_openresponses.types import (
    OpenClawProviderConfig,
    OpenResponsesAgentConfig,
    ProviderType,
)


def _make_input(forwarded_props=None, messages=None, tools=None):
    """Create a minimal RunAgentInput-like mock."""
    inp = MagicMock()
    inp.messages = messages or []
    inp.tools = tools or []
    inp.state = {}
    inp.context = []
    inp.forwarded_props = forwarded_props
    return inp


def _make_tool(name="my_tool", description="A tool", parameters=None):
    """Create a minimal Tool-like mock."""
    t = MagicMock()
    t.name = name
    t.description = description
    t.parameters = parameters or {"type": "object", "properties": {}}
    return t


def _builder(config):
    provider = get_provider(config.provider or ProviderType.CUSTOM)
    return RequestBuilder(config, provider)


class TestResolveModel:
    def test_openclaw_agent_id_routing(self):
        config = OpenResponsesAgentConfig(
            base_url="http://localhost:18789",
            provider=ProviderType.OPENCLAW,
            default_model="openclaw",
        )
        builder = _builder(config)
        inp = _make_input(forwarded_props={"agent_id": "beta"})
        request = builder.build(inp)
        assert request["model"] == "openclaw:beta"

    def test_agent_id_ignored_for_non_openclaw(self):
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
            default_model="gpt-4o",
        )
        builder = _builder(config)
        inp = _make_input(forwarded_props={"agent_id": "beta"})
        request = builder.build(inp)
        assert request["model"] == "gpt-4o"

    def test_forwarded_model_takes_precedence(self):
        config = OpenResponsesAgentConfig(
            base_url="http://localhost:18789",
            provider=ProviderType.OPENCLAW,
            default_model="openclaw",
        )
        builder = _builder(config)
        inp = _make_input(forwarded_props={"model": "agent:foo", "agent_id": "beta"})
        request = builder.build(inp)
        assert request["model"] == "agent:foo"


class TestTranslateTools:
    def test_openclaw_nested_format(self):
        config = OpenResponsesAgentConfig(
            base_url="http://localhost:18789",
            provider=ProviderType.OPENCLAW,
            openclaw=OpenClawProviderConfig(use_nested_tool_format=True),
        )
        builder = _builder(config)
        tool = _make_tool()
        inp = _make_input(tools=[tool])
        request = builder.build(inp)
        t = request["tools"][0]
        assert t["type"] == "function"
        assert "function" in t
        assert t["function"]["name"] == "my_tool"

    def test_openclaw_flat_format(self):
        config = OpenResponsesAgentConfig(
            base_url="http://localhost:18789",
            provider=ProviderType.OPENCLAW,
            openclaw=OpenClawProviderConfig(use_nested_tool_format=False),
        )
        builder = _builder(config)
        tool = _make_tool()
        inp = _make_input(tools=[tool])
        request = builder.build(inp)
        t = request["tools"][0]
        assert t["type"] == "function"
        assert t["name"] == "my_tool"
        # Flat format has no nested "function" key
        assert "function" not in t

    def test_non_openclaw_always_flat(self):
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
        )
        builder = _builder(config)
        tool = _make_tool()
        inp = _make_input(tools=[tool])
        request = builder.build(inp)
        t = request["tools"][0]
        assert t["type"] == "function"
        assert t["name"] == "my_tool"
        assert "function" not in t


class TestAssistantToolCalls:
    """Tests for assistant messages with tool_calls → function_call items."""

    def _make_assistant_msg(self, content="None", tool_calls=None):
        msg = MagicMock()
        msg.role = "assistant"
        msg.content = content
        msg.tool_calls = tool_calls
        return msg

    def _make_tool_call(self, call_id="call_1", name="my_tool", arguments='{"x": 1}'):
        tc = MagicMock()
        tc.id = call_id
        tc.function = MagicMock()
        tc.function.name = name
        tc.function.arguments = arguments
        return tc

    def _make_tool_result_msg(self, tool_call_id="call_1", content='{"status": "ok"}'):
        msg = MagicMock()
        msg.role = "tool"
        msg.tool_call_id = tool_call_id
        msg.content = content
        return msg

    def _make_user_msg(self, content="Hello"):
        msg = MagicMock()
        msg.role = "user"
        msg.content = content
        return msg

    def test_assistant_with_tool_calls_emits_function_call_items(self):
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
        )
        builder = _builder(config)
        tc = self._make_tool_call(call_id="call_abc", name="change_bg", arguments='{"color": "red"}')
        assistant_msg = self._make_assistant_msg(tool_calls=[tc])
        inp = _make_input(messages=[assistant_msg])
        request = builder.build(inp)

        items = request["input"]
        assert len(items) == 1
        assert items[0]["type"] == "function_call"
        assert items[0]["call_id"] == "call_abc"
        assert items[0]["name"] == "change_bg"
        assert items[0]["arguments"] == '{"color": "red"}'

    def test_assistant_without_tool_calls_emits_message(self):
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
        )
        builder = _builder(config)
        assistant_msg = self._make_assistant_msg(content="Hello there")
        inp = _make_input(messages=[assistant_msg])
        request = builder.build(inp)

        items = request["input"]
        assert len(items) == 1
        assert items[0]["type"] == "message"
        assert items[0]["role"] == "assistant"
        assert items[0]["content"] == "Hello there"

    def test_full_tool_call_roundtrip_openai(self):
        """OpenAI: User → Assistant(tool_call) → Tool(result) → User produces correct sequence."""
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
        )
        builder = _builder(config)

        user1 = self._make_user_msg("Change background to blue")
        tc = self._make_tool_call(call_id="call_1", name="change_bg", arguments='{"bg": "blue"}')
        assistant1 = self._make_assistant_msg(tool_calls=[tc])
        tool_result = self._make_tool_result_msg(tool_call_id="call_1", content='{"status": "success"}')
        user2 = self._make_user_msg("Thanks!")

        inp = _make_input(messages=[user1, assistant1, tool_result, user2])
        request = builder.build(inp)

        items = request["input"]
        assert len(items) == 4
        assert items[0]["type"] == "message"
        assert items[0]["role"] == "user"
        assert items[1]["type"] == "function_call"
        assert items[1]["call_id"] == "call_1"
        assert items[2]["type"] == "function_call_output"
        assert items[2]["call_id"] == "call_1"
        assert items[3]["type"] == "message"
        assert items[3]["role"] == "user"

    def test_full_tool_call_roundtrip_huggingface_preserves_tool_items(self):
        """HF router supports Responses API format, so tool items are preserved."""
        config = OpenResponsesAgentConfig(
            base_url="https://router.huggingface.co/v1",
            provider=ProviderType.HUGGINGFACE,
        )
        builder = _builder(config)

        user1 = self._make_user_msg("Change background to blue")
        tc = self._make_tool_call(call_id="call_1", name="change_bg", arguments='{"bg": "blue"}')
        assistant1 = self._make_assistant_msg(tool_calls=[tc])
        tool_result = self._make_tool_result_msg(tool_call_id="call_1", content='{"status": "success"}')
        user2 = self._make_user_msg("Thanks!")

        inp = _make_input(messages=[user1, assistant1, tool_result, user2])
        request = builder.build(inp)

        items = request["input"]
        assert len(items) == 4
        assert items[0]["type"] == "message"
        assert items[0]["role"] == "user"
        assert items[1]["type"] == "function_call"
        assert items[1]["name"] == "change_bg"
        assert items[2]["type"] == "function_call_output"
        assert items[3]["type"] == "message"
        assert items[3]["role"] == "user"

    def test_no_previous_response_id_for_huggingface(self):
        """HF provider should not send previous_response_id."""
        config = OpenResponsesAgentConfig(
            base_url="https://router.huggingface.co/v1",
            provider=ProviderType.HUGGINGFACE,
        )
        builder = _builder(config)
        inp = _make_input(messages=[self._make_user_msg("Hi")])
        inp.state = {"openresponses_state": {"response_id": "resp_123"}}
        request = builder.build(inp)

        assert "previous_response_id" not in request
        # Should send full message history instead
        assert len(request["input"]) == 1

    def test_multiple_tool_calls_on_single_assistant_message(self):
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
        )
        builder = _builder(config)
        tc1 = self._make_tool_call(call_id="call_1", name="tool_a", arguments='{}')
        tc2 = self._make_tool_call(call_id="call_2", name="tool_b", arguments='{"x": 1}')
        assistant_msg = self._make_assistant_msg(tool_calls=[tc1, tc2])
        inp = _make_input(messages=[assistant_msg])
        request = builder.build(inp)

        items = request["input"]
        assert len(items) == 2
        assert items[0]["type"] == "function_call"
        assert items[0]["name"] == "tool_a"
        assert items[1]["type"] == "function_call"
        assert items[1]["name"] == "tool_b"


class TestUserField:
    def test_user_included_when_provided(self):
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
        )
        builder = _builder(config)
        inp = _make_input()
        request = builder.build(inp, user="alice")
        assert request["user"] == "alice"

    def test_user_omitted_when_none(self):
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
        )
        builder = _builder(config)
        inp = _make_input()
        request = builder.build(inp)
        assert "user" not in request
