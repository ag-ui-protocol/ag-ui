"""Tests for provider detection, defaults, and class-based API."""

import os
from unittest.mock import MagicMock

import pytest

from ag_ui_openresponses.providers.base import (
    Provider,
    detect_provider,
    get_provider,
    get_provider_defaults,
)
from ag_ui_openresponses.providers.openclaw import OpenClawProvider
from ag_ui_openresponses.types import ProviderType


class TestDetectProvider:
    def test_openai(self):
        assert detect_provider("https://api.openai.com/v1") == ProviderType.OPENAI

    def test_azure(self):
        assert detect_provider("https://myresource.openai.azure.com") == ProviderType.AZURE

    def test_huggingface(self):
        assert detect_provider("https://api-inference.huggingface.co/v1") == ProviderType.HUGGINGFACE

    def test_openclaw_localhost(self):
        assert detect_provider("http://localhost:18789") == ProviderType.OPENCLAW

    def test_openclaw_custom_domain(self):
        assert detect_provider("https://my-openclaw.example.com") == ProviderType.OPENCLAW

    def test_custom(self):
        assert detect_provider("https://custom-llm.example.com") == ProviderType.CUSTOM


class TestGetProviderDefaults:
    def test_openai(self):
        defaults = get_provider_defaults(ProviderType.OPENAI)
        assert defaults["default_model"] == "gpt-4o"

    def test_azure_empty(self):
        defaults = get_provider_defaults(ProviderType.AZURE)
        assert defaults == {}

    def test_huggingface(self):
        defaults = get_provider_defaults(ProviderType.HUGGINGFACE)
        assert defaults["default_model"] == "meta-llama/Llama-3.3-70B-Instruct"

    def test_openclaw(self):
        defaults = get_provider_defaults(ProviderType.OPENCLAW)
        assert defaults["default_model"] == "openclaw"

    def test_custom_empty(self):
        defaults = get_provider_defaults(ProviderType.CUSTOM)
        assert defaults == {}


class TestGetProvider:
    def test_returns_provider_instance(self):
        p = get_provider(ProviderType.OPENAI)
        assert isinstance(p, Provider)
        assert p.default_model == "gpt-4o"

    def test_openclaw_provider(self):
        p = get_provider(ProviderType.OPENCLAW)
        assert isinstance(p, OpenClawProvider)
        assert p.default_model == "openclaw"

    def test_custom_returns_base(self):
        p = get_provider(ProviderType.CUSTOM)
        assert type(p) is Provider


class TestResolveBaseUrl:
    def test_base_provider_adds_v1(self):
        p = Provider()
        assert p.resolve_base_url("https://api.openai.com") == "https://api.openai.com/v1"

    def test_base_provider_keeps_v1(self):
        p = Provider()
        assert p.resolve_base_url("https://api.openai.com/v1") == "https://api.openai.com/v1"

    def test_base_provider_strips_trailing_slash(self):
        p = Provider()
        assert p.resolve_base_url("https://api.openai.com/v1/") == "https://api.openai.com/v1"

    def test_azure_adds_openai_prefix(self):
        from ag_ui_openresponses.providers.azure import AzureProvider
        p = AzureProvider()
        assert p.resolve_base_url("https://myresource.openai.azure.com") == "https://myresource.openai.azure.com/openai"

    def test_azure_no_double_openai(self):
        from ag_ui_openresponses.providers.azure import AzureProvider
        p = AzureProvider()
        assert p.resolve_base_url("https://myresource.openai.azure.com/openai") == "https://myresource.openai.azure.com/openai"

    def test_azure_strips_trailing_slash(self):
        from ag_ui_openresponses.providers.azure import AzureProvider
        p = AzureProvider()
        assert p.resolve_base_url("https://myresource.openai.azure.com/") == "https://myresource.openai.azure.com/openai"

    def test_huggingface_adds_v1(self):
        from ag_ui_openresponses.providers.huggingface import HuggingFaceProvider
        p = HuggingFaceProvider()
        assert p.resolve_base_url("https://router.huggingface.co") == "https://router.huggingface.co/v1"


class TestOpenClawProviderDefaultUserId:
    def test_returns_user_env_var(self, monkeypatch):
        monkeypatch.setenv("USER", "alice")
        p = OpenClawProvider()
        inp = MagicMock()
        assert p.default_user_id(inp) == "alice"

    def test_falls_back_to_user_string(self, monkeypatch):
        monkeypatch.delenv("USER", raising=False)
        p = OpenClawProvider()
        inp = MagicMock()
        assert p.default_user_id(inp) == "user"

    def test_base_provider_returns_none(self):
        p = Provider()
        inp = MagicMock()
        assert p.default_user_id(inp) is None
