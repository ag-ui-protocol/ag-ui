"""Tests for OpenResponsesAgent._build_headers()."""

import pytest

from ag_ui_openresponses.agent import OpenResponsesAgent
from ag_ui_openresponses.types import (
    OpenClawProviderConfig,
    OpenResponsesAgentConfig,
    ProviderType,
)


class TestBuildHeaders:
    def test_openclaw_headers_present(self):
        config = OpenResponsesAgentConfig(
            base_url="http://localhost:18789",
            provider=ProviderType.OPENCLAW,
            openclaw=OpenClawProviderConfig(agent_id="beta", session_key="s1"),
        )
        agent = OpenResponsesAgent(config)
        headers = agent._build_headers(config)
        assert headers["x-openclaw-agent-id"] == "beta"
        assert headers["x-openclaw-session-key"] == "s1"

    def test_openclaw_no_agent_id_or_session_key(self):
        config = OpenResponsesAgentConfig(
            base_url="http://localhost:18789",
            provider=ProviderType.OPENCLAW,
            openclaw=OpenClawProviderConfig(),
        )
        agent = OpenResponsesAgent(config)
        headers = agent._build_headers(config)
        assert "x-openclaw-agent-id" not in headers
        assert "x-openclaw-session-key" not in headers

    def test_custom_headers_passthrough(self):
        config = OpenResponsesAgentConfig(
            base_url="http://localhost:18789",
            headers={"X-Custom": "val"},
        )
        agent = OpenResponsesAgent(config)
        headers = agent._build_headers(config)
        assert headers["X-Custom"] == "val"

    def test_no_openclaw_config(self):
        config = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            provider=ProviderType.OPENAI,
        )
        agent = OpenResponsesAgent(config)
        headers = agent._build_headers(config)
        assert "x-openclaw-agent-id" not in headers
        assert "x-openclaw-session-key" not in headers
