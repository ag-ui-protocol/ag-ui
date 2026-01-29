"""AG-UI OpenResponses Integration.

This package provides an AG-UI agent that connects to any
OpenResponses-compatible endpoint, including OpenAI, Azure OpenAI,
Hugging Face, and Moltbot.
"""

from .agent import OpenResponsesAgent
from .endpoint import create_openresponses_endpoint
from .providers import detect_provider, get_provider_defaults
from .types import (
    AzureProviderConfig,
    MoltbotProviderConfig,
    OpenResponsesAgentConfig,
    ProviderType,
)

__all__ = [
    # Main class
    "OpenResponsesAgent",
    # Endpoint factory
    "create_openresponses_endpoint",
    # Configuration
    "OpenResponsesAgentConfig",
    "MoltbotProviderConfig",
    "AzureProviderConfig",
    "ProviderType",
    # Utilities
    "detect_provider",
    "get_provider_defaults",
]
