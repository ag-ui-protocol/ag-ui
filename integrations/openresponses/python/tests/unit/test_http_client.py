"""Tests for HttpClient URL construction and header building."""

import pytest

from ag_ui_openresponses.utils.http_client import HttpClient


class TestBuildUrl:
    def test_standard_url(self):
        client = HttpClient(base_url="http://localhost:18789")
        assert client._build_url("/responses") == "http://localhost:18789/v1/responses"

    def test_base_url_ending_with_v1(self):
        client = HttpClient(base_url="https://api.openai.com/v1")
        assert client._build_url("/responses") == "https://api.openai.com/v1/responses"

    def test_azure_api_version(self):
        client = HttpClient(
            base_url="https://myresource.openai.azure.com",
            api_version="2024-02-15-preview",
        )
        url = client._build_url("/responses")
        assert "api-version=2024-02-15-preview" in url
        assert url.startswith("https://myresource.openai.azure.com/openai/v1/responses")

    def test_azure_base_url_with_openai_prefix(self):
        """Don't double the /openai prefix if user already included it."""
        client = HttpClient(
            base_url="https://myresource.openai.azure.com/openai",
            api_version="2024-02-15-preview",
        )
        url = client._build_url("/responses")
        assert url.startswith("https://myresource.openai.azure.com/openai/v1/responses")
        assert "/openai/openai/" not in url

    def test_azure_base_url_with_openai_v1(self):
        """Don't insert extra segments if user provides full path."""
        client = HttpClient(
            base_url="https://myresource.openai.azure.com/openai/v1",
            api_version="2024-02-15-preview",
        )
        url = client._build_url("/responses")
        assert url.startswith("https://myresource.openai.azure.com/openai/v1/responses")
        assert "api-version=2024-02-15-preview" in url

    def test_trailing_slash_stripped(self):
        client = HttpClient(base_url="http://localhost:18789/")
        assert client._build_url("/responses") == "http://localhost:18789/v1/responses"


class TestBuildHeaders:
    def test_bearer_auth(self):
        client = HttpClient(base_url="http://localhost:18789", api_key="sk-test")
        headers = client._build_headers()
        assert headers["Authorization"] == "Bearer sk-test"
        assert "api-key" not in headers

    def test_azure_auth(self):
        client = HttpClient(
            base_url="https://myresource.openai.azure.com",
            api_key="az-key",
            api_version="2024-02-15-preview",
        )
        headers = client._build_headers()
        assert headers["api-key"] == "az-key"
        assert "Authorization" not in headers

    def test_no_api_key(self):
        client = HttpClient(base_url="http://localhost:18789")
        headers = client._build_headers()
        assert "Authorization" not in headers
        assert "api-key" not in headers

    def test_custom_headers_passthrough(self):
        client = HttpClient(
            base_url="http://localhost:18789",
            headers={
                "x-openclaw-agent-id": "beta",
                "x-openclaw-session-key": "s1",
            },
        )
        headers = client._build_headers()
        assert headers["x-openclaw-agent-id"] == "beta"
        assert headers["x-openclaw-session-key"] == "s1"

    def test_content_type_and_accept(self):
        client = HttpClient(base_url="http://localhost:18789")
        headers = client._build_headers()
        assert headers["Content-Type"] == "application/json"
        assert headers["Accept"] == "text/event-stream"
