"""Tests for user_id resolution in OpenResponsesAgent."""

import os
from unittest.mock import MagicMock

import pytest

from ag_ui_openresponses.agent import OpenResponsesAgent
from ag_ui_openresponses.types import (
    OpenResponsesAgentConfig,
    ProviderType,
)


def _make_input():
    inp = MagicMock()
    inp.forwarded_props = {}
    inp.messages = []
    inp.tools = []
    inp.state = {}
    inp.context = []
    return inp


class TestResolveUserId:
    def test_no_config_returns_none(self):
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                provider=ProviderType.OPENAI,
            )
        )
        assert agent._resolve_user_id(_make_input()) is None

    def test_static_user_id(self):
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                provider=ProviderType.OPENAI,
            ),
            user_id="bob",
        )
        assert agent._resolve_user_id(_make_input()) == "bob"

    def test_extractor(self):
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                provider=ProviderType.OPENAI,
            ),
            user_id_extractor=lambda inp: "from-extractor",
        )
        assert agent._resolve_user_id(_make_input()) == "from-extractor"

    def test_mutual_exclusivity(self):
        with pytest.raises(ValueError, match="mutually exclusive"):
            OpenResponsesAgent(
                OpenResponsesAgentConfig(
                    base_url="https://api.openai.com/v1",
                ),
                user_id="x",
                user_id_extractor=lambda inp: "y",
            )

    def test_openclaw_default_user(self, monkeypatch):
        monkeypatch.setenv("USER", "alice")
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="http://localhost:18789",
                provider=ProviderType.OPENCLAW,
            )
        )
        assert agent._resolve_user_id(_make_input()) == "alice"

    def test_openclaw_default_fallback(self, monkeypatch):
        monkeypatch.delenv("USER", raising=False)
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="http://localhost:18789",
                provider=ProviderType.OPENCLAW,
            )
        )
        assert agent._resolve_user_id(_make_input()) == "user"

    def test_extractor_overrides_openclaw_default(self, monkeypatch):
        monkeypatch.setenv("USER", "alice")
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="http://localhost:18789",
                provider=ProviderType.OPENCLAW,
            ),
            user_id_extractor=lambda inp: "custom",
        )
        assert agent._resolve_user_id(_make_input()) == "custom"
