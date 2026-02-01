"""Unit tests for types and merge_runtime_config."""

import pytest

from ag_ui_openresponses import (
    AzureProviderConfig,
    OpenClawProviderConfig,
    OpenResponsesAgentConfig,
    ProviderType,
    merge_runtime_config,
)


class TestMergeRuntimeConfig:
    """Tests for merge_runtime_config."""

    def test_simple_scalar_override(self):
        base = OpenResponsesAgentConfig(base_url="https://api.openai.com/v1")
        result = merge_runtime_config(base, {"api_key": "sk-test"})
        assert result.api_key == "sk-test"
        assert result.base_url == "https://api.openai.com/v1"

    def test_base_url_override(self):
        base = OpenResponsesAgentConfig(base_url="https://old.com")
        result = merge_runtime_config(base, {"base_url": "https://new.com"})
        assert result.base_url == "https://new.com"

    def test_unknown_keys_ignored(self):
        base = OpenResponsesAgentConfig(base_url="https://api.openai.com/v1")
        result = merge_runtime_config(base, {"unknown_field": "value"})
        assert result.base_url == "https://api.openai.com/v1"
        assert not hasattr(result, "unknown_field")

    def test_openclaw_dict_converted(self):
        base = OpenResponsesAgentConfig()
        result = merge_runtime_config(base, {
            "openclaw": {"agent_id": "main", "session_key": "sess-1"},
        })
        assert isinstance(result.openclaw, OpenClawProviderConfig)
        assert result.openclaw.agent_id == "main"
        assert result.openclaw.session_key == "sess-1"

    def test_azure_dict_converted(self):
        base = OpenResponsesAgentConfig()
        result = merge_runtime_config(base, {
            "azure": {"api_version": "2024-02-01"},
        })
        assert isinstance(result.azure, AzureProviderConfig)
        assert result.azure.api_version == "2024-02-01"

    def test_provider_string_converted(self):
        base = OpenResponsesAgentConfig()
        result = merge_runtime_config(base, {"provider": "openai"})
        assert result.provider == ProviderType.OPENAI

    def test_does_not_mutate_base(self):
        base = OpenResponsesAgentConfig(base_url="https://original.com", api_key="orig")
        merge_runtime_config(base, {"api_key": "new"})
        assert base.api_key == "orig"

    def test_multiple_overrides(self):
        base = OpenResponsesAgentConfig(
            base_url="https://api.openai.com/v1",
            default_model="gpt-4o",
            timeout_seconds=60.0,
        )
        result = merge_runtime_config(base, {
            "default_model": "gpt-4o-mini",
            "timeout_seconds": 30.0,
            "max_retries": 1,
        })
        assert result.default_model == "gpt-4o-mini"
        assert result.timeout_seconds == 30.0
        assert result.max_retries == 1
        assert result.base_url == "https://api.openai.com/v1"

    def test_empty_runtime_returns_copy(self):
        base = OpenResponsesAgentConfig(base_url="https://api.openai.com/v1")
        result = merge_runtime_config(base, {})
        assert result.base_url == base.base_url
        assert result is not base
