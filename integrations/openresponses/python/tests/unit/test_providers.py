"""Tests for provider detection and defaults."""

import pytest

from ag_ui_openresponses.providers.base import detect_provider, get_provider_defaults
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
