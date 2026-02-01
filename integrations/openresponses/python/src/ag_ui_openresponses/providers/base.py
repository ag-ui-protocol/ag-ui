"""Provider detection and configuration utilities."""

from __future__ import annotations

from typing import Any

from ..types import ProviderType


def detect_provider(base_url: str) -> ProviderType:
    """Detect provider from base URL.

    Args:
        base_url: The base URL of the endpoint.

    Returns:
        Detected provider type.
    """
    url = base_url.lower()

    if "api.openai.com" in url:
        return ProviderType.OPENAI

    if "openai.azure.com" in url:
        return ProviderType.AZURE

    if "huggingface.co" in url:
        return ProviderType.HUGGINGFACE

    # OpenClaw typically runs on localhost or custom domains
    # Check for common OpenClaw ports or explicit identifiers
    if ":18789" in url or "openclaw" in url:
        return ProviderType.OPENCLAW

    return ProviderType.CUSTOM


def get_provider_defaults(provider: ProviderType) -> dict[str, Any]:
    """Get default configuration for a provider.

    Args:
        provider: The provider type.

    Returns:
        Dictionary of default configuration values.
    """
    defaults: dict[ProviderType, dict[str, Any]] = {
        ProviderType.OPENAI: {
            "default_model": "gpt-4o",
        },
        ProviderType.AZURE: {
            # Azure requires explicit model/deployment
        },
        ProviderType.HUGGINGFACE: {
            "default_model": "meta-llama/Llama-3.3-70B-Instruct",
        },
        ProviderType.OPENCLAW: {
            "default_model": "openclaw",
            # OpenClaw uses the model field for agent routing
            # Format: "openclaw:<agentId>"
        },
        ProviderType.CUSTOM: {},
    }

    return defaults.get(provider, {})
