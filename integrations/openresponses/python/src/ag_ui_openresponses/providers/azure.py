"""Azure OpenAI provider."""

from __future__ import annotations

from .base import Provider


class AzureProvider(Provider):
    default_model: str | None = None
