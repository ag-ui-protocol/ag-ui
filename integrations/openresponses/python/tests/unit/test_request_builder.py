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
