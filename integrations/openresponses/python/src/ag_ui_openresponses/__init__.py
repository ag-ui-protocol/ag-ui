"""AG-UI OpenResponses Integration.

This package provides an AG-UI agent that connects to any
OpenResponses-compatible endpoint, including OpenAI, Azure OpenAI,
Hugging Face, and OpenClaw.
"""

from .agent import OpenResponsesAgent
from .endpoint import create_openresponses_endpoint
from .providers import detect_provider, get_provider_defaults
from .types import (
    AzureProviderConfig,
    OpenClawProviderConfig,
    OpenResponsesAgentConfig,
    ProviderType,
    merge_runtime_config,
)

__all__ = [
    # Main class
    "OpenResponsesAgent",
    # Endpoint factory
    "create_openresponses_endpoint",
    # Configuration
    "OpenResponsesAgentConfig",
    "OpenClawProviderConfig",
    "AzureProviderConfig",
    "ProviderType",
    # Utilities
    "detect_provider",
    "get_provider_defaults",
    "merge_runtime_config",
]
