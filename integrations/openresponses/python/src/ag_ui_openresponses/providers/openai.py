"""OpenAI provider."""

from __future__ import annotations

from .base import Provider


class OpenAIProvider(Provider):
    default_model: str | None = "gpt-4o"
