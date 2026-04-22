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
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OPENAI_API_KEY environment variable is required when MODEL_PROVIDER=openai. "
                "Set it in your .env file or environment."
            )
        from strands.models.openai_responses import OpenAIResponsesModel
        return OpenAIResponsesModel(
            client_args={
                "api_key": api_key,
            },
            model_id=os.getenv("MODEL_ID", "gpt-5.4"),
            params={
                "reasoning": {"effort": "medium", "summary": "auto"},
            }
        )
    elif provider == "anthropic":
        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError(
                "ANTHROPIC_API_KEY environment variable is required when MODEL_PROVIDER=anthropic. "
                "Set it in your .env file or environment."
            )
        from strands.models.anthropic import AnthropicModel
        return AnthropicModel(
            client_args={
                "api_key": api_key,
            },
            model_id=os.getenv("MODEL_ID", "claude-sonnet-4-6"),
            params={
                "budget_tokens": 5000,
            }
        )
    elif provider == "gemini":
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise ValueError(
                "GOOGLE_API_KEY environment variable is required when MODEL_PROVIDER=gemini. "
                "Set it in your .env file or environment."
            )
        from strands.models.gemini import GeminiModel
        return GeminiModel(
            client_args={
                "api_key": api_key,
            },
            model_id=os.getenv("MODEL_ID", "gemini-2.5-flash"),
            params={
                "temperature": 0.7,
                "max_output_tokens": 2048,
            }
        )
    else:
        raise ValueError(f"Unknown MODEL_PROVIDER: {provider}. Supported: openai, anthropic, gemini")
