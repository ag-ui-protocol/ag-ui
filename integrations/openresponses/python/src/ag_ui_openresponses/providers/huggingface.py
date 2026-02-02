"""Hugging Face provider."""

from __future__ import annotations

from .base import Provider


class HuggingFaceProvider(Provider):
    default_model: str | None = "meta-llama/Llama-3.3-70B-Instruct"
    supports_stateful: bool = False
