"""Shared model factory for Strands examples.

Supports OpenAI, Anthropic, and Gemini via MODEL_PROVIDER env var.
Defaults to OpenAI.
"""
import os
import logging

logger = logging.getLogger(__name__)


def create_model():
    """Create a Strands model based on MODEL_PROVIDER env var.

    Supported providers: openai (default), anthropic, gemini
    """
    provider = os.getenv("MODEL_PROVIDER", "openai").lower()

    if provider == "openai":
        from strands.models.openai import OpenAIModel
        return OpenAIModel(
            client_args={
                "api_key": os.getenv("OPENAI_API_KEY"),
            },
            model_id=os.getenv("MODEL_ID", "gpt-5.4"),
            params={
                "reasoning_effort": "medium",
            }
        )
    elif provider == "anthropic":
        from strands.models.anthropic import AnthropicModel
        return AnthropicModel(
            client_args={
                "api_key": os.getenv("ANTHROPIC_API_KEY"),
            },
            model_id=os.getenv("MODEL_ID", "claude-sonnet-4-6"),
            params={
                "budget_tokens": 5000,
            }
        )
    elif provider == "gemini":
        from strands.models.gemini import GeminiModel
        return GeminiModel(
            client_args={
                "api_key": os.getenv("GOOGLE_API_KEY"),
            },
            model_id=os.getenv("MODEL_ID", "gemini-2.5-flash"),
            params={
                "temperature": 0.7,
                "max_output_tokens": 2048,
            }
        )
    else:
        raise ValueError(f"Unknown MODEL_PROVIDER: {provider}. Supported: openai, anthropic, gemini")
