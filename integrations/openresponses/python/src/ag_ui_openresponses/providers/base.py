"""Provider base class, detection, and factory."""

from __future__ import annotations

import os
from typing import Any, TYPE_CHECKING

from ..types import ProviderType

if TYPE_CHECKING:
    from ag_ui.core import RunAgentInput, Tool
    from ..types import OpenResponsesAgentConfig
    from openai.types.responses import FunctionToolParam


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


class Provider:
    """Base provider with sensible defaults."""

    default_model: str | None = None
    supports_stateful: bool = True

    def build_headers(self, config: OpenResponsesAgentConfig) -> dict[str, str]:
        """Build request headers for this provider."""
        return dict(config.headers or {})

    def resolve_model(self, input_data: RunAgentInput, config: OpenResponsesAgentConfig) -> str:
        """Resolve the model identifier for a request."""
        fp = input_data.forwarded_props if hasattr(input_data, "forwarded_props") else None
        if fp and isinstance(fp, dict) and "model" in fp:
            return str(fp["model"])
        return config.default_model or self.default_model or "gpt-4o"

    def translate_tools(
        self, tools: list[Tool], config: OpenResponsesAgentConfig
    ) -> list[FunctionToolParam | dict[str, Any]] | None:
        """Translate AG-UI tools to OpenResponses format (flat by default)."""
        if not tools:
            return None

        from openai.types.responses import FunctionToolParam as FTP

        result: list[FTP | dict[str, Any]] = []
        for tool in tools:
            result.append(
                FTP(
                    type="function",
                    name=tool.name,
                    description=tool.description or "",
                    parameters=tool.parameters or {},
                )
            )
        return result

    def default_user_id(self, input_data: RunAgentInput) -> str | None:
        """Return a provider-specific default user id, or None."""
        return None


def get_provider(provider_type: ProviderType) -> Provider:
    """Return a Provider instance for the given type."""
    from .openai import OpenAIProvider
    from .azure import AzureProvider
    from .huggingface import HuggingFaceProvider
    from .openclaw import OpenClawProvider

    _registry: dict[ProviderType, type[Provider]] = {
        ProviderType.OPENAI: OpenAIProvider,
        ProviderType.AZURE: AzureProvider,
        ProviderType.HUGGINGFACE: HuggingFaceProvider,
        ProviderType.OPENCLAW: OpenClawProvider,
    }
    cls = _registry.get(provider_type, Provider)
    return cls()


# Backwards-compat alias
def get_provider_defaults(provider: ProviderType) -> dict[str, Any]:
    """Get default configuration for a provider (legacy helper)."""
    p = get_provider(provider)
    if p.default_model:
        return {"default_model": p.default_model}
    return {}
