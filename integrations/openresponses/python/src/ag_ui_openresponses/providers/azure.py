"""Azure OpenAI provider."""

from __future__ import annotations

from .base import Provider


class AzureProvider(Provider):
    default_model: str | None = None

    def resolve_base_url(self, base_url: str) -> str:
        """Azure uses ``/openai`` prefix without ``/v1``."""
        base_url = base_url.rstrip("/")
        if "/openai" not in base_url:
            base_url = f"{base_url}/openai"
        return base_url
